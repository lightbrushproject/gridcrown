'use strict';

// Dual-mode match store. Zero deps: global fetch + stdlib only.
//
// Blob mode when process.env.BLOB_READ_WRITE_TOKEN is set (production on
// Vercel): one private JSON blob per match at pathname matches/<CODE>.json.
// Memory mode otherwise (local dev and tests): an in-process Map.
// Both modes expose identical async semantics.
//
// A match record carries a version integer: 1 at creation, bumped by exactly
// one on every save (join, start, each move request resolution, restore).

const crypto = require('crypto');
const core = require('./core');

const matches = new Map(); // memory-mode backing only
const BOT_CAP = 2000;

function blobToken() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

function blobPath(code) {
  return `matches/${String(code).toUpperCase()}.json`;
}

function storeIdFromToken(token) {
  // Token format: vercel_blob_rw_<storeId>_<secret>
  const prefix = 'vercel_blob_rw_';
  const rest = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  const i = rest.indexOf('_');
  return i === -1 ? rest : rest.slice(0, i);
}

async function blobWrite(match) {
  const token = blobToken();
  const url = 'https://blob.vercel-storage.com/?pathname=' + encodeURIComponent(blobPath(match.code));
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      // Current @vercel/blob wire format (fixed 2026-11-08): API version 13,
      // access via x-vercel-blob-access, store id header. The old v7 +
      // x-access pattern defaults to public access and a private store
      // rejects the PUT with 400 "Cannot use public access on a private
      // store" — the bug that silently killed production match persistence.
      'x-api-version': '13',
      'x-vercel-blob-store-id': storeIdFromToken(token),
      'x-vercel-blob-access': 'private',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-content-type': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(match),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`blob write failed with status ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function blobRead(code) {
  const token = blobToken();
  const storeId = storeIdFromToken(token);
  // ?cache=0 is load-bearing: private blob reads are CDN-cached by default
  // (@vercel/blob get() useCache option), and a match record is overwritten
  // at a fixed pathname on every move. Without the bypass, reads serve
  // stale versions and cached 404s — the failure that killed production
  // matches on 2026-11-08 even after writes were fixed.
  const url = `https://${storeId}.private.blob.vercel-storage.com/${blobPath(code)}?cache=0`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return undefined; // no such match
  if (!res.ok) {
    throw new Error(`blob read failed with status ${res.status}`);
  }
  return await res.json();
}

function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const buf = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) code += alphabet[buf[i] % alphabet.length];
  return code;
}

async function get(code) {
  if (!code) return undefined;
  const clean = String(code).toUpperCase();
  if (blobToken()) return blobRead(clean);
  return matches.get(clean);
}

async function has(code) {
  return (await get(code)) !== undefined;
}

async function uniqueCode(want) {
  if (want) {
    const clean = String(want).toUpperCase().slice(0, 12);
    if (!(await has(clean))) return clean;
  }
  let code = genCode();
  while (await has(code)) code = genCode();
  return code;
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Persist the final record. Bumps version exactly once per call, so every
// mutation path must end with exactly one save.
async function save(match) {
  match.version = (Number.isInteger(match.version) ? match.version : 0) + 1;
  if (blobToken()) await blobWrite(match);
  else matches.set(match.code, match);
  return match;
}

function snapshotBoard(state) {
  return state.board.map((c) => ({ o: c.owner, s: c.shields, b: c.isBase }));
}

function seatName(match, seat) {
  const p = match.players.find((pl) => pl.seat === seat);
  return p ? p.name : `Seat ${seat}`;
}

function withNames(match, events) {
  return events.map((e) => String(e).replace(/Seat (\d+)/g, (m, n) => {
    const p = match.players.find((pl) => pl.seat === Number(n));
    return p ? p.name : m;
  }));
}

// Apply one action and append a log entry. Throws on illegal action.
// Pure in-memory mutation; the caller saves the record once per request.
function applyAndLog(match, seat, action) {
  const events = core.applyAction(match.state, seat, action);
  const named = withNames(match, events);
  match.state.logCount = match.log.length + 1;
  const entry = {
    n: match.log.length + 1,
    seat,
    action: { ...action },
    events: named,
    text: named.join(' '),
    snapshot: snapshotBoard(match.state),
  };
  match.log.push(entry);
  return events;
}

async function createMatch({ name, seats, fillBots }) {
  const state = core.createMatch({ seats });
  const code = await uniqueCode(null);
  state.code = code;
  const clean = String(name || 'Player').trim().slice(0, 24) || 'Player';
  state.names[0] = clean;
  state.kinds[0] = 'human';
  const match = {
    code,
    state,
    players: [{ seat: 0, name: clean, kind: 'human', token: genToken() }],
    fillBots: fillBots !== false,
    log: [],
    version: 0,
  };
  await save(match); // version becomes 1
  return match;
}

// Play one bot seat turn. Returns actions played.
function playBotTurn(match, seat) {
  let played = 0;
  while (match.state.status === 'active' && match.state.turnSeat === seat && match.state.apLeft > 0) {
    const action = core.botChooseAction(match.state, seat);
    if (!action || action.type === 'end') break;
    const score = core.scoreMove(match.state, seat, action);
    if (score <= 0) break;
    applyAndLog(match, seat, action);
    played++;
  }
  if (match.state.status === 'active' && match.state.turnSeat === seat) {
    applyAndLog(match, seat, { type: 'end' });
    played++;
  }
  return played;
}

// Chain consecutive bot turns with a safety cap per request.
function chainBots(match) {
  let total = 0;
  while (match.state.status === 'active' && total < BOT_CAP) {
    const seat = match.state.turnSeat;
    const p = match.players.find((pl) => pl.seat === seat);
    if (!p || p.kind !== 'bot') break;
    const before = match.log.length;
    playBotTurn(match, seat);
    total += match.log.length - before;
    if (match.log.length === before) break; // no progress, avoid spin
  }
}

function fillEmptyWithBots(match) {
  for (let s = 0; s < match.state.seats; s++) {
    if (!match.players.some((pl) => pl.seat === s)) {
      match.players.push({ seat: s, name: 'BOT', kind: 'bot', token: genToken() });
      match.state.names[s] = 'BOT';
      match.state.kinds[s] = 'bot';
    }
  }
  match.players.sort((a, b) => a.seat - b.seat);
}

// Disaster-recovery rebuild: re-apply logged actions verbatim.
// No bot auto-play during restore. Issues fresh tokens.
async function restoreMatch(code, players, log) {
  const cleanCode = String(code || '').toUpperCase().slice(0, 12);
  if (!cleanCode) throw new Error('code required');
  if (await has(cleanCode)) {
    const err = new Error('code already in use');
    err.code = 'IN_USE';
    throw err;
  }
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error('players must list 2..4 seats');
  }
  if (!Array.isArray(log)) throw new Error('log must be an array');
  const seats = players.length;
  const state = core.createMatch({ seats });
  state.code = cleanCode;
  const match = { code: cleanCode, state, players: [], fillBots: true, log: [], version: 0 };
  players.forEach((p, i) => {
    const nm = String((p && p.name) || `Seat ${i}`).trim().slice(0, 24) || `Seat ${i}`;
    const kind = p && p.kind === 'bot' ? 'bot' : 'human';
    match.players.push({ seat: i, name: nm, kind, token: genToken() });
    state.names[i] = nm;
    state.kinds[i] = kind;
  });
  core.beginMatch(state);
  // Re-apply verbatim in log order. Each entry carries seat + action.
  const ordered = [...log].sort((a, b) => (a.n || 0) - (b.n || 0));
  for (const e of ordered) {
    if (!e || typeof e.seat !== 'number' || !e.action) continue;
    applyAndLog(match, e.seat, e.action);
  }
  await save(match); // version becomes 1
  return match;
}

function publicLog(match) {
  return {
    code: match.code,
    players: match.players.map((p) => ({ seat: p.seat, name: p.name, kind: p.kind })),
    log: match.log,
  };
}

module.exports = {
  matches, createMatch, get, has, save, applyAndLog, chainBots, playBotTurn,
  fillEmptyWithBots, restoreMatch, publicLog, genToken, snapshotBoard, BOT_CAP,
};
