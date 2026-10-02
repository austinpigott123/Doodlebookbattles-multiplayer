"use strict";

const crypto = require("crypto");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const RECONNECT_MS = 2 * 60 * 1000;
const RULESETS = new Set(["quick_scrap", "page_war", "entire_page"]);
const rooms = new Map();

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, game: "ogs-blockheads", rooms: rooms.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

function send(client, message) {
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate room code");
}

function makePlayer(slot, client) {
  return {
    slot,
    client,
    token: crypto.randomBytes(18).toString("base64url"),
    team: -1,
    rollReady: false,
    disconnectedAt: 0,
  };
}

function broadcast(room, message, exceptSlot = 0) {
  for (const player of room.players.values()) {
    if (player.slot !== exceptSlot) send(player.client, message);
  }
}

function publicLobby(room) {
  return {
    type: "lobby_state",
    room: room.code,
    players: room.players.size,
    phase: room.phase,
    ruleset: room.ruleset,
    winner_slot: room.winnerSlot,
    teams: Object.fromEntries([...room.players].map(([slot, player]) => [slot, player.team])),
  };
}

function attach(client, room, player) {
  player.client = client;
  player.disconnectedAt = 0;
  client.roomCode = room.code;
  client.slot = player.slot;
  send(client, {
    type: "room_joined",
    room: room.code,
    slot: player.slot,
    reconnect_token: player.token,
    ruleset: room.ruleset,
  });
  send(client, publicLobby(room));
  if (room.latestState) send(client, { type: "state", seq: room.sequence, payload: room.latestState });
  broadcast(room, publicLobby(room));
}

function rollInitiative(room) {
  const first = crypto.randomInt(1, 7);
  const second = crypto.randomInt(1, 7);
  if (first === second) {
    broadcast(room, { type: "roll_tie", rolls: { 1: first, 2: second } });
    setTimeout(() => rollInitiative(room), 900);
    return;
  }
  room.winnerSlot = first > second ? 1 : 2;
  room.phase = "faction_choice";
  broadcast(room, {
    type: "roll_result",
    rolls: { 1: first, 2: second },
    winner_slot: room.winnerSlot,
  });
}

function handle(client, message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "create") {
    const code = roomCode();
    const requestedRuleset = String(message.ruleset || "entire_page");
    const ruleset = RULESETS.has(requestedRuleset) ? requestedRuleset : "entire_page";
    const room = {
      code,
      ruleset,
      createdAt: Date.now(),
      phase: "waiting",
      players: new Map(),
      winnerSlot: 0,
      activeTeam: 0,
      sequence: 0,
      latestState: null,
    };
    const player = makePlayer(1, client);
    room.players.set(1, player);
    rooms.set(code, room);
    attach(client, room, player);
    return;
  }
  if (message.type === "join" || message.type === "reconnect") {
    const code = String(message.room || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(client, { type: "error", message: "Room not found." });
    if (message.type === "reconnect") {
      const token = String(message.reconnect_token || "");
      const player = [...room.players.values()].find((entry) => entry.token === token);
      if (!player) return send(client, { type: "error", message: "Reconnect token expired." });
      attach(client, room, player);
      return;
    }
    if (room.players.size >= 2) return send(client, { type: "error", message: "Room is full." });
    const player = makePlayer(2, client);
    room.players.set(2, player);
    attach(client, room, player);
    room.phase = "initiative";
    broadcast(room, { type: "opponent_joined", room: code });
    broadcast(room, publicLobby(room));
    return;
  }

  const room = rooms.get(client.roomCode);
  const player = room && room.players.get(client.slot);
  if (!room || !player) return send(client, { type: "error", message: "Join a room first." });

  if (message.type === "roll_ready" && room.phase === "initiative") {
    player.rollReady = true;
    if ([...room.players.values()].every((entry) => entry.rollReady)) rollInitiative(room);
    return;
  }
  if (message.type === "choose_faction" && room.phase === "faction_choice") {
    if (player.slot !== room.winnerSlot) return send(client, { type: "error", message: "The roll winner chooses the faction." });
    const team = Number(message.team);
    if (![0, 1].includes(team)) return;
    player.team = team;
    for (const other of room.players.values()) if (other.slot !== player.slot) other.team = 1 - team;
    room.phase = "first_turn_choice";
    broadcast(room, { type: "faction_result", teams: Object.fromEntries([...room.players].map(([slot, entry]) => [slot, entry.team])), chooser_slot: player.slot });
    return;
  }
  if (message.type === "choose_first" && room.phase === "first_turn_choice") {
    if (player.slot === room.winnerSlot) return send(client, { type: "error", message: "The other player chooses first turn." });
    const firstSlot = Number(message.first_slot);
    if (![1, 2].includes(firstSlot)) return;
    room.activeTeam = room.players.get(firstSlot).team;
    room.phase = "playing";
    broadcast(room, { type: "match_start", ruleset: room.ruleset, teams: Object.fromEntries([...room.players].map(([slot, entry]) => [slot, entry.team])), first_slot: firstSlot, active_team: room.activeTeam });
    return;
  }
  if (message.type === "state" && room.phase === "playing") {
    if (player.team !== room.activeTeam) return send(client, { type: "error", message: "State rejected: not your turn." });
    const sequence = Number(message.seq);
    if (!Number.isSafeInteger(sequence) || sequence <= room.sequence || typeof message.payload !== "object") return;
    room.sequence = sequence;
    room.latestState = message.payload;
    room.activeTeam = Number(message.active_team);
    broadcast(room, { type: "state", seq: sequence, payload: message.payload }, player.slot);
    return;
  }
  if (message.type === "event" && room.phase === "playing") {
    if (player.team !== room.activeTeam || typeof message.event !== "object") return;
    broadcast(room, { type: "event", event: message.event }, player.slot);
    return;
  }
  if (message.type === "ping") send(client, { type: "pong", now: Date.now() });
}

wss.on("connection", (client) => {
  client.on("message", (bytes) => {
    try { handle(client, JSON.parse(bytes.toString())); }
    catch (error) { send(client, { type: "error", message: "Invalid network message." }); }
  });
  client.on("close", () => {
    const room = rooms.get(client.roomCode);
    const player = room && room.players.get(client.slot);
    if (!room || !player) return;
    player.client = null;
    player.disconnectedAt = Date.now();
    broadcast(room, { type: "opponent_disconnected", reconnect_seconds: RECONNECT_MS / 1000 });
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const staleRoom = now - room.createdAt > ROOM_TTL_MS;
    const allGone = [...room.players.values()].every((player) => !player.client && now - player.disconnectedAt > RECONNECT_MS);
    if (staleRoom || allGone) rooms.delete(code);
  }
}, 30000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Ogs & Blockheads relay listening on ${PORT}`);
});
