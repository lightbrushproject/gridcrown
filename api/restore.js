'use strict';
// POST /api/restore -> restoreMatch (cold-start recovery)
const handlers = require('../lib/handlers');

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const r = await handlers.restoreMatch({ body: bodyOf(req) });
  return res.status(r.status).json(r.json);
};
