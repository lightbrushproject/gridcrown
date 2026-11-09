'use strict';

// GRIDCROWN core engine: pure game logic, no I/O.
// Deterministic except botChooseAction tie-breaking (Math.random).

const W = 6;
const H = 6;
const CELLS = W * H;
const MAX_ROUNDS = 12;
const BASE_HP = 3;
const MAX_SHIELDS = 2;
const BASE_POS = [
  { x: 0, y: 0 }, // seat 0
  { x: 5, y: 5 }, // seat 1
  { x: 5, y: 0 }, // seat 2
  { x: 0, y: 5 }, // seat 3
];
const COST = { expand: 1, fortify: 1, strike: 2, end: 0 };

function idx(x, y) {
  return y * W + x;
}

function inBoard(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < W && y >= 0 && y < H;
}

function neighbors(x, y) {
  const out = [];
  if (x > 0) out.push({ x: x - 1, y });
  if (x < W - 1) out.push({ x: x + 1, y });
  if (y > 0) out.push({ x, y: y - 1 });
  if (y < H - 1) out.push({ x, y: y + 1 });
  return out;
}

function cellAt(state, x, y) {
  return state.board[idx(x, y)];
}

function cellsOwned(state, seat) {
  let n = 0;
  for (const c of state.board) if (c.owner === seat) n++;
  return n;
}

function computeAp(state, seat) {
  return Math.min(6, 3 + Math.floor(cellsOwned(state, seat) / 6));
}

function aliveSeats(state) {
  const out = [];
  for (let s = 0; s < state.seats; s++) if (state.alive[s]) out.push(s);
  return out;
}

function ownsNeighbor(state, seat, x, y) {
  for (const n of neighbors(x, y)) {
    if (cellAt(state, n.x, n.y).owner === seat) return true;
  }
  return false;
}

function createMatch({ seats }) {
  const n = Number(seats) || 2;
  if (n < 2 || n > 4) throw new Error('seats must be 2..4');
  const board = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      board.push({ x, y, owner: -1, shields: 0, isBase: false });
    }
  }
  const alive = [];
  const baseHp = [];
  for (let s = 0; s < n; s++) {
    alive.push(true);
    baseHp.push(BASE_HP);
    const p = BASE_POS[s];
    const c = board[idx(p.x, p.y)];
    c.owner = s;
    c.isBase = true;
  }
  return {
    code: '',
    status: 'lobby',
    seats: n,
    round: 0,
    turnSeat: null,
    apLeft: 0,
    board,
    alive,
    baseHp,
    winner: null,
    names: [],
    kinds: [],
    logCount: 0,
  };
}

// Move from lobby to active play. Called by the store when starting.
function beginMatch(state) {
  state.status = 'active';
  state.round = 1;
  state.turnSeat = 0;
  state.apLeft = computeAp(state, 0);
}

// Score for one seat. Eliminated seats count baseHp as 0.
function scoreOf(state, seat) {
  const hp = state.alive[seat] ? state.baseHp[seat] : 0;
  return cellsOwned(state, seat) + 2 * hp;
}

function finishByScore(state, events) {
  state.status = 'finished';
  let best = -1;
  let bestHp = -1;
  let win = 0;
  for (let s = 0; s < state.seats; s++) {
    const hp = state.alive[s] ? state.baseHp[s] : 0;
    const sc = cellsOwned(state, s) + 2 * hp;
    if (sc > best || (sc === best && (hp > bestHp || (hp === bestHp && s < win)))) {
      best = sc;
      bestHp = hp;
      win = s;
    }
  }
  state.winner = win;
  state.turnSeat = null;
  if (events) events.push(`Match scored. Seat ${win} wins with ${best} points.`);
}

function finishByElimination(state, survivor, events) {
  state.status = 'finished';
  state.winner = survivor;
  state.turnSeat = null;
  if (events) events.push(`Seat ${survivor} wins by elimination.`);
}

// Advance to the next alive seat, or finish at the round cap.
function endTurn(state, events) {
  if (state.status !== 'active') return;
  const alive = aliveSeats(state);
  if (alive.length <= 1) {
    finishByElimination(state, alive[0] != null ? alive[0] : 0, events);
    return;
  }
  const cur = state.turnSeat;
  const pos = alive.indexOf(cur);
  const isLast = pos === alive.length - 1;
  if (isLast && state.round >= MAX_ROUNDS) {
    finishByScore(state, events);
    return;
  }
  if (isLast) {
    state.round += 1;
    state.turnSeat = alive[0];
  } else {
    state.turnSeat = alive[pos + 1];
  }
  state.apLeft = computeAp(state, state.turnSeat);
}

function legalMoves(state, seat) {
  if (state.status !== 'active') return [];
  if (state.turnSeat !== seat) return [];
  if (!state.alive[seat]) return [];
  const moves = [];
  const ap = state.apLeft;
  if (ap >= COST.expand) {
    for (const c of state.board) {
      if (c.owner === -1 && ownsNeighbor(state, seat, c.x, c.y)) {
        moves.push({ type: 'expand', x: c.x, y: c.y });
      }
    }
    for (const c of state.board) {
      if (c.owner === seat && c.shields < MAX_SHIELDS) {
        moves.push({ type: 'fortify', x: c.x, y: c.y });
      }
    }
  }
  if (ap >= COST.strike) {
    for (const c of state.board) {
      if (c.owner !== -1 && c.owner !== seat && ownsNeighbor(state, seat, c.x, c.y)) {
        moves.push({ type: 'strike', x: c.x, y: c.y });
      }
    }
  }
  moves.push({ type: 'end' });
  return moves;
}

function fmtCell(x, y) {
  return `(${x},${y})`;
}

// Validate and apply one action. Mutates state. Returns event strings.
// Throws Error with a human-readable message when illegal.
function applyAction(state, seat, action) {
  if (!action || typeof action.type !== 'string') throw new Error('missing action type');
  if (state.status !== 'active') throw new Error('match is not active');
  if (!state.alive[seat]) throw new Error('you are eliminated');
  if (state.turnSeat !== seat) throw new Error('not your turn');
  const type = action.type;
  const events = [];
  const who = `Seat ${seat}`;

  if (type === 'end') {
    events.push(`${who} ended their turn.`);
    endTurn(state, events);
    return events;
  }

  const x = action.x;
  const y = action.y;
  if (!inBoard(x, y)) throw new Error('target off board');
  const cell = cellAt(state, x, y);

  if (type === 'expand') {
    if (state.apLeft < COST.expand) throw new Error('not enough AP');
    if (cell.owner !== -1) throw new Error('expand target must be unowned');
    if (!ownsNeighbor(state, seat, x, y)) throw new Error('expand target must touch your territory');
    cell.owner = seat;
    cell.shields = 0;
    state.apLeft -= COST.expand;
    events.push(`${who} expanded to ${fmtCell(x, y)}.`);
  } else if (type === 'fortify') {
    if (state.apLeft < COST.fortify) throw new Error('not enough AP');
    if (cell.owner !== seat) throw new Error('fortify target must be yours');
    if (cell.shields >= MAX_SHIELDS) throw new Error('cell already has max shields');
    cell.shields += 1;
    state.apLeft -= COST.fortify;
    events.push(`${who} fortified ${fmtCell(x, y)}.`);
  } else if (type === 'strike') {
    if (state.apLeft < COST.strike) throw new Error('not enough AP');
    if (cell.owner === -1 || cell.owner === seat) throw new Error('strike target must be an enemy cell');
    if (!ownsNeighbor(state, seat, x, y)) throw new Error('strike target must touch your territory');
    const defender = cell.owner;
    state.apLeft -= COST.strike;
    if (cell.shields > 0) {
      cell.shields -= 1;
      events.push(`${who} struck ${fmtCell(x, y)}, shield down.`);
    } else if (cell.isBase) {
      state.baseHp[defender] -= 1;
      events.push(`${who} hit Seat ${defender} base, HP now ${state.baseHp[defender]}.`);
      if (state.baseHp[defender] <= 0) {
        state.baseHp[defender] = 0;
        cell.isBase = false;
        cell.shields = 0;
        cell.owner = seat;
        state.alive[defender] = false;
        for (const c of state.board) {
          if (c !== cell && c.owner === defender) {
            c.owner = -1;
            c.shields = 0;
          }
        }
        events.push(`${who} captured Seat ${defender} base. Seat ${defender} eliminated.`);
      }
    } else {
      cell.owner = seat;
      cell.shields = 0;
      events.push(`${who} captured ${fmtCell(x, y)} from Seat ${defender}.`);
    }
  } else {
    throw new Error(`unknown action: ${type}`);
  }

  // Elimination wins immediately.
  const alive = aliveSeats(state);
  if (alive.length <= 1 && state.status === 'active') {
    finishByElimination(state, alive[0] != null ? alive[0] : seat, events);
    return events;
  }
  // Auto end when AP runs out.
  if (state.apLeft <= 0 && state.status === 'active') {
    state.apLeft = 0;
    endTurn(state, events);
  }
  return events;
}

// --- Bot heuristic ---

function enemyAdjacentCount(state, seat, x, y) {
  let n = 0;
  for (const nb of neighbors(x, y)) {
    const o = cellAt(state, nb.x, nb.y).owner;
    if (o !== -1 && o !== seat) n++;
  }
  return n;
}

function adjacentToEnemyBase(state, seat, x, y) {
  for (const nb of neighbors(x, y)) {
    const c = cellAt(state, nb.x, nb.y);
    if (c.isBase && c.owner !== -1 && c.owner !== seat) return true;
  }
  return false;
}

function isOwnBase(state, seat, x, y) {
  const p = BASE_POS[seat];
  return p && p.x === x && p.y === y;
}

function scoreMove(state, seat, move) {
  if (move.type === 'end') return 0;
  const cell = cellAt(state, move.x, move.y);
  if (move.type === 'strike') {
    if (cell.isBase) {
      if (cell.shields > 0) return 70;
      let s = 100;
      if (state.baseHp[cell.owner] <= 2) s += 50;
      return s;
    }
    return cell.shields > 0 ? 30 : 45;
  }
  if (move.type === 'fortify') {
    if (isOwnBase(state, seat, move.x, move.y)) {
      return enemyAdjacentCount(state, seat, move.x, move.y) > 0 ? 55 : 15;
    }
    let s = 8;
    if (enemyAdjacentCount(state, seat, move.x, move.y) > 0) s += 10;
    return s;
  }
  if (move.type === 'expand') {
    let s = 20 + 6 * enemyAdjacentCount(state, seat, move.x, move.y);
    if (adjacentToEnemyBase(state, seat, move.x, move.y)) s += 10;
    return s;
  }
  return 0;
}

function botChooseAction(state, seat) {
  const moves = legalMoves(state, seat);
  if (moves.length === 0) return { type: 'end' };
  let best = -1;
  let cands = [];
  for (const m of moves) {
    const s = scoreMove(state, seat, m);
    if (s > best) {
      best = s;
      cands = [m];
    } else if (s === best) {
      cands.push(m);
    }
  }
  return cands[Math.floor(Math.random() * cands.length)];
}

// Public JSON view. forSeat null means anonymous.
function publicState(state, forSeatOrNull) {
  const board = state.board.map((c) => ({
    x: c.x, y: c.y, owner: c.owner, shields: c.shields, isBase: c.isBase,
  }));
  const players = [];
  for (let s = 0; s < state.seats; s++) {
    const alive = !!state.alive[s];
    const baseHp = alive ? state.baseHp[s] : 0;
    players.push({
      seat: s,
      name: (state.names && state.names[s]) || `Seat ${s}`,
      kind: (state.kinds && state.kinds[s]) || 'human',
      alive,
      cells: cellsOwned(state, s),
      baseHp,
      score: cellsOwned(state, s) + 2 * baseHp,
    });
  }
  const out = {
    code: state.code,
    status: state.status,
    seats: state.seats,
    round: state.round,
    turnSeat: state.turnSeat,
    apLeft: state.apLeft,
    board,
    players,
    winner: state.winner,
    logCount: state.logCount || 0,
  };
  if (forSeatOrNull !== null && forSeatOrNull !== undefined) {
    out.you = forSeatOrNull;
    if (state.status === 'active' && state.turnSeat === forSeatOrNull && state.alive[forSeatOrNull]) {
      out.legalMoves = legalMoves(state, forSeatOrNull);
    }
  }
  return out;
}

module.exports = {
  W, H, CELLS, MAX_ROUNDS, BASE_HP, MAX_SHIELDS, BASE_POS, COST,
  createMatch, beginMatch, legalMoves, applyAction, endTurn,
  botChooseAction, scoreMove, publicState, cellsOwned, computeAp,
  aliveSeats, scoreOf,
};
