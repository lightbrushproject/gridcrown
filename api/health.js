'use strict';
// GET /api/health -> health
const handlers = require('../lib/handlers');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const r = handlers.health({});
  return res.status(r.status).json(r.json);
};
