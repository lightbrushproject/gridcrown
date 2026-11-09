'use strict';

// GRIDCROWN local dev server. Plain node:http, zero deps.
// Same routes as the Vercel adapters, plus / serving the client.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const handlers = require('./lib/handlers');

const PORT = Number(process.env.PORT) || 8377;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

function serveIndex(res) {
  const file = path.join(__dirname, 'public', 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('client missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // Static client.
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  // README for the client footer link.
  if (method === 'GET' && pathname === '/README.md') {
    fs.readFile(path.join(__dirname, 'README.md'), (err, data) => {
      if (err) { sendJson(res, 404, { error: 'not found' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Health.
  if (method === 'GET' && pathname === '/api/health') {
    const r = handlers.health({});
    sendJson(res, r.status, r.json);
    return;
  }

  // Restore.
  if (method === 'POST' && pathname === '/api/restore') {
    const body = await readBody(req);
    const r = await handlers.restoreMatch({ body });
    sendJson(res, r.status, r.json);
    return;
  }

  // Create.
  if (method === 'POST' && pathname === '/api/matches') {
    const body = await readBody(req);
    const r = await handlers.createMatch({ body });
    sendJson(res, r.status, r.json);
    return;
  }

  // Match sub-routes: /api/matches/:code[/join|/start|/move|/log]
  const m = pathname.match(/^\/api\/matches\/([^/]+)(\/(join|start|move|log))?$/);
  if (m) {
    const code = decodeURIComponent(m[1]);
    const sub = m[3] || '';
    if (method === 'GET' && sub === '') {
      const r = await handlers.getState({ params: { code }, query: { token: url.searchParams.get('token') } });
      sendJson(res, r.status, r.json);
      return;
    }
    if (method === 'GET' && sub === 'log') {
      const r = await handlers.getLog({ params: { code } });
      sendJson(res, r.status, r.json);
      return;
    }
    if (method === 'POST' && sub === 'join') {
      const body = await readBody(req);
      const r = await handlers.joinMatch({ params: { code }, body });
      sendJson(res, r.status, r.json);
      return;
    }
    if (method === 'POST' && sub === 'start') {
      const body = await readBody(req);
      const r = await handlers.startMatch({ params: { code }, body });
      sendJson(res, r.status, r.json);
      return;
    }
    if (method === 'POST' && sub === 'move') {
      const body = await readBody(req);
      const r = await handlers.postMove({ params: { code }, body });
      sendJson(res, r.status, r.json);
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`gridcrown on http://localhost:${PORT}`);
  });
}

module.exports = server;
