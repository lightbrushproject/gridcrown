'use strict';
// GET /api/matches/:code/log -> {code, players, log}
const handlers = require('../../../lib/handlers');

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const q = req.query || {};
  const r = await handlers.getLog({ params: { code: first(q.code) } });
  return res.status(r.status).json(r.json);
};
