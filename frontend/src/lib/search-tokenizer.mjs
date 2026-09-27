/**
 * Canonical CJK-aware tokenizer for the build-time static search index.
 *
 * Shared by BOTH sides so index time and query time always agree:
 *   - scripts/build-search-index.mjs (indexing)
 *   - frontend/src/lib/static-search.ts (lazy client queries)
 *
 * Latin words/dates are lowercased whole; Chinese runs become bigrams (so
 * 「国庆」 matches 「国庆节」) with single characters kept for 1-char runs.
 */

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const tokens = [];
  for (const match of text.match(/[a-zA-Z0-9][a-zA-Z0-9._/-]*/g) ?? []) tokens.push(match.toLowerCase());
  for (const run of text.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}
