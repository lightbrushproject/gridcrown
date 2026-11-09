'use strict';

// Request handlers shared by server.js and the Vercel adapters.
// Each takes {params, query, body} and returns {status, json}.
// All store access is async (durable Blob mode or in-memory mode).

const core = require('./core');
const store = require('./store');

function viewFor(match, seatOrNull) {
  const base = core.publicState(match.state, seatOrNull);
  base.version = match.version;
  // Enrich with authoritative names/kinds and filled seats only.
  const stats = new Map(base.players.map((p) => [p.seat, p]));
  base.players = match.players.map((pl) => {
    const s = stats.get(pl.seat) || {};
    return {
      seat: pl.seat,
      name: pl.name,
      kind: pl.kind,
      alive: s.alive !== undefined ? s.alive : true,
      cells: s.cells || 0,
      baseHp: s.baseHp || 0,
      score: s.score || 0,
    };
  });
  base.logCount = match.log.length;
  return base;
}

function needBody(body) {
  return body && typeof body === 'object' ? body : {};
}

async function createMatch({ body }) {
  const b = needBody(body);
  const seats = b.seats === undefined ? 2 : Number(b.seats);
  if (![2, 3, 4].includes(seats)) {
    return { status: 400, json: { error: 'seats must be 2, 3, or 4' } };
  }
  const match = await store.createMatch({ name: b.name, seats, fillBots: b.fillBots });
  const host = match.players[0];
  return {
    status: 200,
    json: { code: match.code, token: host.token, seat: 0, state: viewFor(match, 0) },
  };
}

async function joinMatch({ params, body }) {
  const match = await store.get(params && params.code);
  if (!match) return { status: 404, json: { error: 'unknown match code' } };
  if (match.state.status !== 'lobby') {
    return { status: 409, json: { error: 'match already started' } };
  }
  if (match.players.length >= match.state.seats) {
    return { status: 409, json: { error: 'match is full' } };
  }
  const b = needBody(body);
  const seat = match.players.length;
  const clean = String(b.name || 'Player').trim().slice(0, 24) || 'Player';
  const token = store.genToken();
  match.players.push({ seat, name: clean, kind: 'human', token });
  match.state.names[seat] = clean;
  match.state.kinds[seat] = 'human';
  await store.save(match);
  return { status: 200, json: { token, seat, state: viewFor(match, seat) } };
}

async function startMatch({ params, body }) {
  const match = await store.get(params && params.code);
  if (!match) return { status: 404, json: { error: 'unknown match code' } };
  const b = needBody(body);
  const host = match.players.find((p) => p.seat === 0);
  if (!host || b.token !== host.token) {
    return { status: 403, json: { error: 'only the host (seat 0) can start' } };
  }
  if (match.state.status !== 'lobby') {
    return { status: 409, json: { error: 'match already started' } };
  }
  const humans = match.players.filter((p) => p.kind === 'human').length;
  if (humans < 2 && match.fillBots === false) {
    return { status: 409, json: { error: 'need at least 2 human players when fillBots is false' } };
  }
  store.fillEmptyWithBots(match);
  core.beginMatch(match.state);
  store.chainBots(match);
  await store.save(match);
  return { status: 200, json: { state: viewFor(match, 0) } };
}

async function getState({ params, query }) {
  const match = await store.get(params && params.code);
  if (!match) return { status: 404, json: { error: 'unknown match code' } };
  const token = query && query.token;
  let seat = null;
  if (token) {
    const p = match.players.find((pl) => pl.token === token);
    if (p) seat = p.seat;
  }
  return { status: 200, json: viewFor(match, seat) };
}

async function postMove({ params, body }) {
  const match = await store.get(params && params.code);
  if (!match) return { status: 404, json: { error: 'unknown match code' } };
  const b = needBody(body);
  const player = match.players.find((pl) => pl.token === b.token);
  if (!player) return { status: 403, json: { error: 'bad token' } };
  if (b.ifVersion !== undefined && b.ifVersion !== null && b.ifVersion !== match.version) {
    return { status: 409, json: { error: 'state advanced, re-read state and retry', version: match.version } };
  }
  if (match.state.status !== 'active') {
    return { status: 409, json: { error: 'match is not active' } };
  }
  if (match.state.turnSeat !== player.seat) {
    return { status: 409, json: { error: 'not your turn' } };
  }
  const action = { type: b.type };
  if (b.x !== undefined) action.x = b.x;
  if (b.y !== undefined) action.y = b.y;
  try {
    store.applyAndLog(match, player.seat, action);
  } catch (err) {
    return { status: 422, json: { error: err.message || 'illegal action' } };
  }
  store.chainBots(match);
  await store.save(match);
  return { status: 200, json: { state: viewFor(match, player.seat) } };
}

async function getLog({ params }) {
  const match = await store.get(params && params.code);
  if (!match) return { status: 404, json: { error: 'unknown match code' } };
  return { status: 200, json: store.publicLog(match) };
}

async function restoreMatch({ body }) {
  const b = needBody(body);
  const code = b.code ? String(b.code).toUpperCase().slice(0, 12) : null;
  if (code && await store.has(code)) {
    return { status: 409, json: { error: 'code already in use, pick a free code' } };
  }
  if (!Array.isArray(b.players) || !Array.isArray(b.log)) {
    return { status: 400, json: { error: 'body needs {code, players, log}' } };
  }
  try {
    // Use the requested code when free, else mint one.
    const want = code || undefined;
    let match;
    if (want) {
      match = await store.restoreMatch(want, b.players, b.log);
    } else {
      const tmp = require('crypto').randomBytes(2).toString('hex').toUpperCase();
      match = await store.restoreMatch('R' + tmp, b.players, b.log);
    }
    const tokens = {};
    for (const p of match.players) tokens[p.seat] = p.token;
    return { status: 200, json: { code: match.code, tokens, state: viewFor(match, null) } };
  } catch (err) {
    if (err.code === 'IN_USE') return { status: 409, json: { error: err.message } };
    return { status: 400, json: { error: err.message || 'restore failed' } };
  }
}

function health() {
  return { status: 200, json: { ok: true, game: 'gridcrown' } };
}

module.exports = { createMatch, joinMatch, startMatch, getState, postMove, getLog, restoreMatch, health };
