#!/usr/bin/env python3
"""GRIDCROWN sample agent bot. Python stdlib only (urllib).

Usage:
  python3 bot.py <base_url> <code> [--name NAME] [--create]

With --create, creates a 2-seat match with fillBots=false, prints the code,
then waits as seat 0 (run a second bot without --create to join).
Otherwise joins the given code and plays when it is our turn.
"""
import http.client
import json
import random
import sys
import time
import urllib.error
import urllib.request

BASE_POS = [(0, 0), (5, 5), (5, 0), (0, 5)]
POLL = 0.7


def api(base, path, method="GET", body=None):
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    backoffs = (1, 2, 4, 8)
    for attempt in range(5):
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            # 60s: a healthy server can still answer slowly on a bad network
            # path (10s+ responses observed live 2026-11-08); the retry loop
            # above bounds total attempts, so a generous per-try timeout is
            # the difference between riding out a slow patch and dying on it.
            with urllib.request.urlopen(req, timeout=60) as res:
                raw = res.read().decode() or "{}"
                return res.status, json.loads(raw)
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode() or "{}"
                parsed = json.loads(raw)
            except Exception:
                parsed = {}
            if 500 <= e.code <= 599 and attempt < 4:
                time.sleep(backoffs[attempt])
                continue
            return e.code, parsed
        except (OSError, http.client.HTTPException) as e:
            if attempt < 4:
                time.sleep(backoffs[attempt])
                continue
            print(f"connection error: {e}", flush=True)
            sys.exit(2)


def neighbors(x, y):
    out = []
    if x > 0:
        out.append((x - 1, y))
    if x < 5:
        out.append((x + 1, y))
    if y > 0:
        out.append((x, y - 1))
    if y < 5:
        out.append((x, y + 1))
    return out


def score_move(state, seat, move):
    """Same heuristic as the server bot (see lib/core.js scoreMove)."""
    if move.get("type") == "end":
        return 0
    board = {(c["x"], c["y"]): c for c in state["board"]}
    hp = {p["seat"]: p["baseHp"] for p in state["players"]}
    x, y = move["x"], move["y"]
    cell = board[(x, y)]
    mtype = move["type"]

    def enemy_near():
        n = 0
        for nx, ny in neighbors(x, y):
            o = board[(nx, ny)]["owner"]
            if o != -1 and o != seat:
                n += 1
        return n

    def near_enemy_base():
        for nx, ny in neighbors(x, y):
            c = board[(nx, ny)]
            if c["isBase"] and c["owner"] != -1 and c["owner"] != seat:
                return True
        return False

    if mtype == "strike":
        if cell["isBase"]:
            if cell["shields"] > 0:
                return 70
            s = 100
            if hp.get(cell["owner"], 3) <= 2:
                s += 50
            return s
        return 30 if cell["shields"] > 0 else 45
    if mtype == "fortify":
        if (x, y) == BASE_POS[seat]:
            return 55 if enemy_near() > 0 else 15
        return 8 + (10 if enemy_near() > 0 else 0)
    if mtype == "expand":
        s = 20 + 6 * enemy_near()
        if near_enemy_base():
            s += 10
        return s
    return 0


def choose(state, seat):
    moves = state.get("legalMoves") or [{"type": "end"}]
    best = -1
    cands = []
    for m in moves:
        s = score_move(state, seat, m)
        if s > best:
            best = s
            cands = [m]
        elif s == best:
            cands.append(m)
    return random.choice(cands)


def fmt_move(m):
    if m["type"] == "end":
        return "end turn"
    return f"{m['type']} ({m['x']},{m['y']})"


def main():
    args = sys.argv[1:]
    name = "PyBot"
    create = False
    pos = []
    i = 0
    while i < len(args):
        if args[i] == "--name" and i + 1 < len(args):
            name = args[i + 1][:24]
            i += 2
        elif args[i] == "--create":
            create = True
            i += 1
        elif args[i].startswith("--"):
            print(f"unknown flag: {args[i]}", flush=True)
            sys.exit(2)
        else:
            pos.append(args[i])
            i += 1
    if len(pos) < 1:
        print(__doc__.strip(), flush=True)
        sys.exit(2)
    base = pos[0].rstrip("/")
    code = pos[1] if len(pos) > 1 else None

    token = None
    seat = None
    version = None

    if create:
        status, data = api(base, "/api/matches", "POST",
                            {"name": name, "seats": 2, "fillBots": False})
        if status != 200:
            print(f"create failed ({status}): {data.get('error', '?')}", flush=True)
            sys.exit(1)
        code = data["code"]
        token = data["token"]
        seat = data["seat"]
        version = data.get("state", {}).get("version")
        print(f"created match {code} as {name} (seat {seat})", flush=True)
        print(f"run a second bot: python3 bot.py {base} {code} --name <other>", flush=True)
    else:
        if not code:
            print(__doc__.strip(), flush=True)
            sys.exit(2)
        code = code.upper()
        status, data = api(base, f"/api/matches/{code}/join", "POST", {"name": name})
        if status == 404:
            print(f"no match with code {code}", flush=True)
            sys.exit(1)
        if status == 409:
            print(f"cannot join {code}: {data.get('error', '?')} (match full or already started)", flush=True)
            sys.exit(1)
        if status != 200:
            print(f"join failed ({status}): {data.get('error', '?')}", flush=True)
            sys.exit(1)
        token = data["token"]
        seat = data["seat"]
        version = data.get("state", {}).get("version")
        print(f"joined match {code} as {name} (seat {seat})", flush=True)

    known_log = None
    waited_lobby = False
    while True:
        status, data = api(base, f"/api/matches/{code}?token={token}")
        if status == 404:
            if known_log:
                print(f"match {code} not found (server may have restarted). "
                      f"I hold a log with {len(known_log)} entries; "
                      f"recovery is the client's job via POST /api/restore.",
                      flush=True)
            else:
                print(f"match {code} not found on the server.", flush=True)
            sys.exit(1)
        if status != 200:
            print(f"state fetch failed ({status}), retrying...", flush=True)
            time.sleep(POLL)
            continue
        state = data
        version = state.get("version")
        # Keep a fresh log for crash recovery diagnostics.
        ls, ldata = api(base, f"/api/matches/{code}/log")
        if ls == 200 and isinstance(ldata.get("log"), list):
            known_log = ldata["log"]

        if state["status"] == "finished":
            names = {p["seat"]: p["name"] for p in state["players"]}
            win = state["winner"]
            scores = ", ".join(f"{p['name']}={p['score']}" for p in sorted(
                state["players"], key=lambda p: (-p["score"], -p["baseHp"], p["seat"])))
            print(f"match finished. winner: {names.get(win, win)} (seat {win}). scores: {scores}", flush=True)
            print("I won." if win == seat else "I lost.", flush=True)
            sys.exit(0)

        if state["status"] == "lobby":
            filled = len(state["players"])
            if seat == 0 and filled >= state["seats"]:
                s2, d2 = api(base, f"/api/matches/{code}/start", "POST", {"token": token})
                if s2 == 200:
                    if isinstance(d2.get("state"), dict):
                        version = d2["state"].get("version")
                    print("started the match", flush=True)
                else:
                    print(f"start failed ({s2}): {d2.get('error', '?')}", flush=True)
            elif not waited_lobby:
                print(f"in lobby ({filled}/{state['seats']} seats), waiting...", flush=True)
                waited_lobby = True
            time.sleep(POLL)
            continue

        waited_lobby = False
        if state.get("turnSeat") == seat:
            move = choose(state, seat)
            body = {"token": token, **move}
            if version is not None:
                body["ifVersion"] = version
            s2, d2 = api(base, f"/api/matches/{code}/move", "POST", body)
            if s2 == 200:
                if isinstance(d2.get("state"), dict):
                    version = d2["state"].get("version")
                print(f"I play {fmt_move(move)}", flush=True)
            elif s2 == 409:
                pass  # stale version or turn passed; re-poll next loop
            elif s2 == 422:
                print(f"illegal move {fmt_move(move)}: {d2.get('error', '?')} (stale view, refetching)", flush=True)
            else:
                print(f"move failed ({s2}): {d2.get('error', '?')}", flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
