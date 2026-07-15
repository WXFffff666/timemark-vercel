'use strict'

// Thin entry committed to git; heavy bundle is generated at build time.
const built = require('./handler.cjs')
const honoHandler = built.default ?? built

exports.config = {
  runtime: 'nodejs',
  maxDuration: 60,
  ...(built.config ?? {}),
}

// Vercel Node 18+ Web API — Hono expects a standard Request, not (req, res)
exports.fetch = async (request, _context) => honoHandler(request)
