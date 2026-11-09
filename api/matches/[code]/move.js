'use strict';
// POST /api/matches/:code/move -> postMove
const handlers = require('../../../lib/handlers');

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const q = req.query || {};
  const r = await handlers.postMove({ params: { code: first(q.code) }, body: bodyOf(req) });
  return res.status(r.status).json(r.json);
};
