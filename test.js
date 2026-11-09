'use strict';

// GRIDCROWN test runner. Zero deps. Spawns server.js on a test port.

const { spawn } = require('child_process');

const PORT = 8379;
const BASE = `http://localhost:${PORT}`;
let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

function waitForServer(proc, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await api('/api/health');
        if (r.status === 200 && r.data.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function testEngineSanity() {
  const name = '1 engine sanity: create 2-seat fillBots, start, seat 0 to move';
  try {
    const c = await post('/api/matches', { name: 'Tester', seats: 2, fillBots: true });
    if (c.status !== 200) return report(name, false, `create -> ${c.status}`);
    const st = await post(`/api/matches/${c.data.code}/start`, { token: c.data.token });
    if (st.status !== 200) return report(name, false, `start -> ${st.status} ${st.data.error || ''}`);
    const s = st.data.state;
    const ok = s.status === 'active' && s.turnSeat === 0 && s.round === 1 && s.players.length === 2;
    report(name, ok, ok ? `code ${c.data.code}` : JSON.stringify(s).slice(0, 200));
    return c.data; // {code, token, seat}
  } catch (err) {
    report(name, false, String(err));
    return null;
  }
}

async function testIllegalMove(match) {
  const name = '2 illegal move rejected (expand non-adjacent -> 422)';
  try {
    if (!match) return report(name, false, 'no match from test 1');
    // Seat 0 owns only (0,0) area at start; (5,5) is enemy base, far away.
    const r = await post(`/api/matches/${match.code}/move`, {
      token: match.token, type: 'expand', x: 5, y: 5,
    });
    const ok = r.status === 422 && typeof r.data.error === 'string' && r.data.error.length > 0;
    report(name, ok, ok ? r.data.error : `got ${r.status} ${JSON.stringify(r.data)}`);
  } catch (err) {
    report(name, false, String(err));
  }
}

async function testFullMatch() {
  const name = '3 full match to finished with winner and log > 20';
  try {
    const c = await post('/api/matches', { name: 'Driver', seats: 4, fillBots: true });
    if (c.status !== 200) return report(name, false, `create -> ${c.status}`);
    const { code, token } = c.data;
    const st = await post(`/api/matches/${code}/start`, { token });
    if (st.status !== 200) return report(name, false, `start -> ${st.status}`);
    let state = st.data.state;
    let guard = 0;
    while (state.status === 'active' && guard < 3000) {
      guard++;
      const g = await api(`/api/matches/${code}?token=${token}`);
      if (g.status !== 200) return report(name, false, `poll -> ${g.status}`);
      state = g.data;
      if (state.status !== 'active') break;
      if (state.turnSeat !== 0) {
        return report(name, false, `turn stuck on seat ${state.turnSeat} (bots should auto-play)`);
      }
      const moves = state.legalMoves || [{ type: 'end' }];
      const mv = moves[0];
      const body = { token, type: mv.type };
      if (mv.x !== undefined) body.x = mv.x;
      if (mv.y !== undefined) body.y = mv.y;
      const r = await post(`/api/matches/${code}/move`, body);
      if (r.status !== 200) return report(name, false, `move ${JSON.stringify(mv)} -> ${r.status} ${r.data.error || ''}`);
      state = r.data.state;
    }
    const lg = await api(`/api/matches/${code}/log`);
    const logLen = lg.data && lg.data.log ? lg.data.log.length : -1;
    const ok = state.status === 'finished'
      && Number.isInteger(state.winner) && state.winner >= 0 && state.winner < 4
      && logLen > 20;
    report(name, ok, `winner seat ${state.winner}, log ${logLen}, rounds used ${state.round}`);
    return ok ? code : null;
  } catch (err) {
    report(name, false, String(err));
    return null;
  }
}

async function testRestore(code) {
  const name = '4 restore: rebuilt state matches finished state';
  try {
    if (!code) return report(name, false, 'no finished match from test 3');
    const before = await api(`/api/matches/${code}?token=x`);
    const lg = await api(`/api/matches/${code}/log`);
    if (lg.status !== 200) return report(name, false, `log fetch -> ${lg.status}`);
    const newCode = 'T' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const r = await post('/api/restore', {
      code: newCode, players: lg.data.players, log: lg.data.log,
    });
    if (r.status !== 200) return report(name, false, `restore -> ${r.status} ${r.data.error || ''}`);
    const a = before.data;
    const b = r.data.state;
    const ownersA = a.board.map((c) => c.owner).join(',');
    const ownersB = b.board.map((c) => c.owner).join(',');
    const ok = b.winner === a.winner && ownersA === ownersB && b.status === 'finished';
    report(name, ok, ok ? `restored as ${r.data.code}` : `winner ${a.winner}/${b.winner}`);
  } catch (err) {
    report(name, false, String(err));
  }
}

async function testVersionConflict() {
  const name = '5 version conflict: stale ifVersion -> 409, current -> 200';
  try {
    const c = await post('/api/matches', { name: 'Ver', seats: 2, fillBots: true });
    if (c.status !== 200) return report(name, false, `create -> ${c.status}`);
    const { code, token } = c.data;
    const st = await post(`/api/matches/${code}/start`, { token });
    if (st.status !== 200) return report(name, false, `start -> ${st.status}`);
    const g0 = await api(`/api/matches/${code}?token=${token}`);
    if (g0.status !== 200) return report(name, false, `poll -> ${g0.status}`);
    const staleVersion = g0.data.version;
    if (!Number.isInteger(staleVersion)) return report(name, false, 'state has no integer version');
    const moves0 = g0.data.legalMoves || [];
    if (!moves0.length) return report(name, false, 'no legal moves after start');
    const first = moves0.find((m) => m.type !== 'end') || moves0[0];
    const b1 = { token, type: first.type };
    if (first.x !== undefined) b1.x = first.x;
    if (first.y !== undefined) b1.y = first.y;
    // One legal move WITHOUT ifVersion: succeeds (backwards compatible) and bumps version.
    const r1 = await post(`/api/matches/${code}/move`, b1);
    if (r1.status !== 200) return report(name, false, `first move -> ${r1.status} ${r1.data.error || ''}`);
    const currentVersion = r1.data.state.version;
    if (!(Number.isInteger(currentVersion) && currentVersion > staleVersion)) {
      return report(name, false, `version did not bump (${staleVersion} -> ${currentVersion})`);
    }
    if (r1.data.state.turnSeat !== 0) {
      return report(name, false, `expected still seat 0 to move, got turnSeat ${r1.data.state.turnSeat}`);
    }
    const freshMoves = r1.data.state.legalMoves || [];
    if (!freshMoves.length) return report(name, false, 'no legal moves after first move');
    const next = freshMoves.find((m) => m.type !== 'end') || freshMoves[0];
    const staleBody = { token, type: next.type, ifVersion: staleVersion };
    if (next.x !== undefined) staleBody.x = next.x;
    if (next.y !== undefined) staleBody.y = next.y;
    const rStale = await post(`/api/matches/${code}/move`, staleBody);
    const errText = typeof rStale.data.error === 'string' ? rStale.data.error : '';
    if (!(rStale.status === 409 && errText.includes('state advanced'))) {
      return report(name, false, `stale move -> ${rStale.status} ${JSON.stringify(rStale.data)}`);
    }
    if (rStale.data.version !== currentVersion) {
      return report(name, false, `stale 409 missing current version (got ${rStale.data.version})`);
    }
    // Same action WITH the current version succeeds.
    const curBody = { token, type: next.type, ifVersion: currentVersion };
    if (next.x !== undefined) curBody.x = next.x;
    if (next.y !== undefined) curBody.y = next.y;
    const rCur = await post(`/api/matches/${code}/move`, curBody);
    if (rCur.status !== 200) return report(name, false, `current-version move -> ${rCur.status} ${rCur.data.error || ''}`);
    report(name, true, `v${staleVersion} stale rejected, v${currentVersion} accepted`);
  } catch (err) {
    report(name, false, String(err));
  }
}

async function main() {
  const proc = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  try {
    await waitForServer(proc, 10000);
    const m1 = await testEngineSanity();
    await testIllegalMove(m1);
    const finished = await testFullMatch();
    await testRestore(finished);
    await testVersionConflict();
  } catch (err) {
    console.log('FAIL  harness: ' + err.message);
    failures++;
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!proc.killed) proc.kill('SIGKILL');
  }
  console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
