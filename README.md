# GRIDCROWN

Gridcrown is a fast territory strategy game for 2 to 4 players on a 6x6 grid where each player starts with only their corner base (seat 0 top-left, seat 1 bottom-right, seat 2 top-right, seat 3 bottom-left, each base at 3 HP), and play runs in rounds of one turn per living player for at most 12 rounds; at the start of your turn you get AP equal to 3 plus one per 6 cells you own (capped at 6), then spend it on expand (1 AP, claim an unowned cell touching your territory), fortify (1 AP, add a shield up to 2 on a cell you own), strike (2 AP, hit an enemy cell touching your territory to strip a shield, or capture it if unshielded, or damage a base, and a base at 0 HP falls to the attacker while its owner is eliminated and all their other cells go neutral), or end your turn early, with the match ending at once when one player remains or after round 12 on score (cells plus twice base HP, ties by base HP then lower seat).

## Play online

```
https://gridcrown.vercel.app
```

Open the URL, create a match, and share the 4-letter code with friends or bots.

## Run locally

Requires plain `node` (v18 or newer) and optionally `python3` for the sample bot. No packages to install.

```sh
node server.js
```

Then open `http://localhost:8377` in a browser. Set `PORT` to change the port:

```sh
PORT=8080 node server.js
```

Run the test suite (spawns the server on port 8379 automatically):

```sh
node test.js
```

## Agent API

Base URL is the server root. All request and response bodies are JSON. Match codes are short uppercase strings like `KQ7M`.

Token model: creating or joining a match issues a secret token tied to one seat. Include it as `token` in the query string (GET state) or body (moves, start). Tokens of other players are never exposed. A token identifies you; the seat order decides turns.

### Health

`GET /api/health`

Response:

```json
{ "ok": true, "game": "gridcrown" }
```

### Create a match

`POST /api/matches`

Request (`seats` 2..4, default 2; `fillBots` default true):

```json
{ "name": "Amber", "seats": 3, "fillBots": true }
```

Response (you are seat 0, the host):

```json
{
  "code": "KQ7M",
  "token": "9f2c...",
  "seat": 0,
  "state": { "...": "public state, see below" }
}
```

### Join a match

`POST /api/matches/:code/join`

Request:

```json
{ "name": "Birch" }
```

Response:

```json
{
  "token": "ab11...",
  "seat": 1,
  "state": { "...": "public state" }
}
```

Errors: `404` unknown code, `409` match full or already started.

### Start a match

`POST /api/matches/:code/start`

Only the host (seat 0) token works. Empty seats are filled with server bots named `BOT` unless `fillBots` was false at creation, in which case starting needs at least 2 humans.

Request:

```json
{ "token": "9f2c..." }
```

Response:

```json
{ "state": { "...": "public state, now active" } }
```

### Get state

`GET /api/matches/:code?token=OPTIONAL`

With your token the response adds `you` (your seat) and, when it is your turn, `legalMoves`. Public state shape:

```json
{
  "code": "KQ7M",
  "status": "active",
  "seats": 3,
  "round": 2,
  "turnSeat": 1,
  "apLeft": 3,
  "board": [{ "x": 0, "y": 0, "owner": 0, "shields": 1, "isBase": true }],
  "players": [{ "seat": 0, "name": "Amber", "kind": "human", "alive": true, "cells": 5, "baseHp": 3, "score": 11 }],
  "winner": null,
  "logCount": 17,
  "version": 12,
  "you": 1,
  "legalMoves": [{ "type": "expand", "x": 1, "y": 2 }]
}
```

`status` is `lobby`, `active`, or `finished`. `board` always has 36 cells in row-major order. `winner` is a seat index or null. `kind` is `human` or `bot`. `version` is the match record's current version: 1 at creation, bumped on every join, start, move request, and restore.

### Play a move

`POST /api/matches/:code/move`

Request (x, y omitted for `end`):

```json
{ "token": "ab11...", "type": "expand", "x": 1, "y": 2, "ifVersion": 12 }
```

Response:

```json
{ "state": { "...": "your view after the move, bots already chained" } }
```

When your move ends your turn, the server immediately plays all following bot turns inside the same request (safety cap 2000 actions), so the returned state is either your next turn or a finished match.

Optimistic concurrency: send the `version` from your latest state as `ifVersion`. If it no longer matches the server's version, the move is rejected with `409` and body `{ "error": "state advanced, re-read state and retry", "version": <current> }`, and nothing is applied; re-read state and retry with the fresh version. Omitting `ifVersion` still works (backwards compatible).

Legal moves: `legalMoves` lists every action you may send right now, including `{ "type": "end" }`. Sending anything else returns `422` with a human-readable `error` string and changes nothing.

### Match log (replay)

`GET /api/matches/:code/log`

Response:

```json
{
  "code": "KQ7M",
  "players": [{ "seat": 0, "name": "Amber", "kind": "human" }],
  "log": [
    {
      "n": 1,
      "seat": 0,
      "action": { "type": "expand", "x": 1, "y": 0 },
      "events": ["Amber expanded to (1,0)."],
      "text": "Amber expanded to (1,0).",
      "snapshot": [{ "o": 0, "s": 0, "b": true }]
    }
  ]
}
```

Each entry records the board AFTER the action as 36 `{o, s, b}` triples (owner, shields, isBase) in row-major order, so clients can replay step by step. Poll this endpoint during play and keep a copy: it is your recovery ticket.

### Restore (disaster recovery)

`POST /api/restore`

Matches persist in Vercel Blob in production (in-memory only for local dev), so a 404 mid-game should not happen in normal play. If a match ever does go missing, restore is the disaster-recovery path: re-create it from a saved log under a free code. The server re-applies every logged action verbatim (no bot auto-play during the rebuild, since bot actions are already in the log) and issues FRESH tokens for every seat.

Hosting notes: the store keeps one durable JSON blob per match plus optimistic version checks on moves, so any serverless container can serve any match and stale clients get a clean 409 instead of a lost move.

Request:

```json
{
  "code": "KQ7M",
  "players": [{ "seat": 0, "name": "Amber", "kind": "human" }],
  "log": [{ "n": 1, "seat": 0, "action": { "type": "expand", "x": 1, "y": 0 } }]
}
```

Response:

```json
{
  "code": "KQ7M",
  "tokens": { "0": "new-token-for-seat-0" },
  "state": { "...": "rebuilt public state" }
}
```

Pick the token for your seat from `tokens` and keep playing. Errors: `409` if the code is taken (choose another), `400` for a malformed log.

### Error codes

| Code | Meaning |
| ---- | ------- |
| 400 | Bad request body (bad seat count, malformed restore) |
| 403 | Bad token, or not the host for start |
| 404 | Unknown match code |
| 409 | Wrong moment (not your turn, match not active, match full, already started, code in use, stale `ifVersion`) |
| 422 | Illegal action (human-readable `error`, nothing applied) |

## Sample bot

`bot.py` plays with the same heuristic as the server fill bots, using only the Python standard library.

```sh
# Terminal 1: create a match as seat 0 (prints the code, then waits)
python3 bot.py http://localhost:8377 IGNORED --create --name PyBot

# Terminal 2: join it as seat 1 (host auto-starts when full)
python3 bot.py http://localhost:8377 KQ7M --name PyBot2
```

The bot polls every 0.7s, picks the best scored move from `legalMoves`, prints each action, prints the final result, and exits 0 when the match finishes. If the match 404s it prints a recovery hint (restore via `/api/restore`) and exits. Joining a full or started match prints a clean message instead of a traceback.

## Design notes

There is no dominant strategy because every plan taxes itself. Expansion feeds AP income (one extra point per 6 cells) but each new cell is a new attack surface touching more enemies, and a wide border is hard to shield. Strikes cost double AP, so trading blow for blow with a fortifying defender loses the economy race: two shields force three full strikes (6 AP) to capture one cell. Shields are cheap but each fortify is AP not spent growing, and shields do not protect base HP once stripped, so turtling only delays the race. The round cap decides everything else: a base-kill rush can win by elimination, but if it stalls, the territory player wins on score, and score itself splits (cells plus twice base HP), so neither pure sprawl nor pure base defense maximizes it. Bots follow the same scoring, which keeps bot-filled seats honest opponents rather than free cells.

## License

MIT. Built by TaoBot.
