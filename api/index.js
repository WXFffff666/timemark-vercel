'use strict'

// Thin entry committed to git; heavy bundle is generated at build time.
const built = require('./handler.cjs')

module.exports = built.default ?? built
module.exports.config = {
  runtime: 'nodejs',
  maxDuration: 60,
  ...(built.config ?? {}),
}
