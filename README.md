# Ogs & Blockheads room relay

This tiny Node WebSocket service pairs two browser clients with a six-character
room code. It stores only temporary in-memory match state.

## Local test

```bash
npm install
npm start
```

Use `ws://127.0.0.1:8787` in both game clients.

## Internet deployment

Deploy this `relay` folder as a Node web service. The start command is
`npm start`; the service reads the host-provided `PORT`. Copy the resulting
secure WebSocket address into the game's Relay URL field, using `wss://`.

An itch.io page is HTTPS, so its browser build must use `wss://`, not `ws://`.
Rooms expire after two hours and disconnected seats are held for two minutes.
