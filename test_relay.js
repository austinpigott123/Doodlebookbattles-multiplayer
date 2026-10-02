"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const port = 8791;
const server = spawn(process.execPath, ["server.js"], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

function openClient() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", handler);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5000);
    function handler(bytes) {
      const message = JSON.parse(bytes.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", handler);
      resolve(message);
    }
    socket.on("message", handler);
  });
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

async function run() {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (bytes) => {
      if (bytes.toString().includes("listening")) resolve();
    });
    server.once("exit", (code) => reject(new Error(`Relay exited ${code}`)));
  });
  const first = await openClient();
  const second = await openClient();
  const firstJoined = next(first, "room_joined");
  send(first, { type: "create", ruleset: "page_war" });
  const created = await firstJoined;
  assert.match(created.room, /^[A-Z2-9]{6}$/);
  assert.equal(created.ruleset, "page_war");
  const secondJoined = next(second, "room_joined");
  send(second, { type: "join", room: created.room });
  const joined = await secondJoined;
  assert.equal(joined.ruleset, "page_war");
  const firstRoll = next(first, "roll_result");
  const secondRoll = next(second, "roll_result");
  send(first, { type: "roll_ready" });
  send(second, { type: "roll_ready" });
  const roll = await firstRoll;
  await secondRoll;
  const winner = roll.winner_slot === 1 ? first : second;
  const loser = roll.winner_slot === 1 ? second : first;
  const factionForFirst = next(first, "faction_result");
  const factionForSecond = next(second, "faction_result");
  send(winner, { type: "choose_faction", team: 0 });
  const faction = await factionForFirst;
  await factionForSecond;
  const loserSlot = roll.winner_slot === 1 ? 2 : 1;
  const startForFirst = next(first, "match_start");
  const startForSecond = next(second, "match_start");
  send(loser, { type: "choose_first", first_slot: loserSlot });
  const start = await startForFirst;
  await startForSecond;
  assert.equal(start.ruleset, "page_war");
  assert.equal(start.active_team, faction.teams[String(loserSlot)]);
  const receiver = loserSlot === 1 ? second : first;
  const sender = loserSlot === 1 ? first : second;
  const stateReceived = next(receiver, "state");
  send(sender, { type: "state", seq: 1, active_team: 1 - start.active_team, payload: { round_number: 1, marker: "synced" } });
  const state = await stateReceived;
  assert.equal(state.payload.marker, "synced");
  first.close();
  second.close();
  console.log("RELAY_TEST_PASS", created.room);
}

run()
  .then(() => server.kill("SIGTERM"))
  .catch((error) => {
    console.error(error);
    server.kill("SIGTERM");
    process.exitCode = 1;
  });
