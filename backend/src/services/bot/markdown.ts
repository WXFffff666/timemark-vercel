/**
 * Telegram MarkdownV2 escaping, validation and length enforcement (checkbox 95).
 *
 * Two hard rules drive this module:
 *  1. USER-SUPPLIED text must never be interpolated into MarkdownV2 unescaped - a contact
 *     name like `Ann_*Lee` would otherwise open an italic/bold entity and make Telegram
 *     reject the whole message ("can't parse entities").
 *  2. Markup WE intend to emit (`[label](url)`, `*bold*`, ...) must NOT be escaped.
 *
 * `escapeMarkdownV2` is therefore applied per VALUE at construction time, and the
 * transport (`telegram-api.ts`) only enforces the 4096-character limit - centrally, so no
 * handler can bypass it, and entity-safely, so a truncated message is still valid.
 */

/** Characters Telegram requires to be backslash-escaped in normal text. */
export const MARKDOWN_V2_RESERVED = '_*[]()~`>#+-=|{}.!\\';

const RESERVED = new Set(MARKDOWN_V2_RESERVED.split(''));

/** Telegram hard limit for one message text (characters after entities parsing). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Appended to a truncated message. Deliberately free of reserved ASCII characters, so it
 * is valid MarkdownV2 text on its own and can never close/open an entity.
 */
export const TRUNCATION_SUFFIX = '…（完整内容见应用）';

/**
 * Escape a user-supplied value for MarkdownV2.
 *
 * Every reserved character (including `\`) is backslash-escaped exactly once. A backslash
 * that is ALREADY part of an escape sequence (`\_`, `\*`, `\\`, ...) is copied verbatim,
 * which makes the function idempotent: escaping an already-escaped value must not turn
 * `Ann\_Lee` into `Ann\\\_Lee` (that would render a literal backslash instead of the
 * underscore the author meant to escape). The same property protects callers that escape a
 * value once, store it, and escape it again on a later render pass.
 */
export function escapeMarkdownV2(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next !== undefined && RESERVED.has(next)) {
        // Existing escape sequence (or an escaped backslash): keep it as-is.
        out += ch + next;
        i++;
      } else {
        // A lone backslash is reserved on its own.
        out += '\\\\';
      }
      continue;
    }
    out += RESERVED.has(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/**
 * Escape a URL for the `(...)` part of a MarkdownV2 inline link. Telegram only requires
 * `)` and `\` to be escaped there; every other reserved character is allowed inside a URL.
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}

/** Build `[label](url)` with both parts escaped for MarkdownV2. */
export function markdownLink(label: string, url: string): string {
  return `[${escapeMarkdownV2(label)}](${escapeMarkdownV2Url(url)})`;
}

// ---------------------------------------------------------------------------
// Validation (test oracle: "the message still parses")
// ---------------------------------------------------------------------------

interface LinkAwaitFrame { kind: 'linkAwait' }
interface LinkUrlFrame { kind: 'linkUrl' }
interface EntityFrame { kind: 'entity'; token: string }
type Frame = LinkAwaitFrame | LinkUrlFrame | EntityFrame;

function isReservedEscapeTarget(next: string | undefined): boolean {
  return next !== undefined && RESERVED.has(next);
}

/**
 * Validate a MarkdownV2 string the way Telegram's parser would (strict docs rules):
 *  - `\` must start a valid escape sequence,
 *  - entities (`*`, `_`, `__`, `~`, `||`, backtick, triple backtick) must be balanced,
 *  - links must be `[text](url)` with `]` immediately followed by `(`,
 *  - reserved characters in normal text (and in link text) must be escaped,
 *  - inside a URL only `)` and `\` are structural.
 *
 * Returns a list of human-readable problems; an empty list means the message is valid.
 * It is intentionally pure and safe to call in tests without a Telegram connection.
 */
export function validateMarkdownV2(text: string): string[] {
  const errors: string[] = [];
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const inUrl = (): boolean => top()?.kind === 'linkUrl';

  const toggleEntity = (token: string): void => {
    const current = top();
    if (current?.kind === 'entity' && current.token === token) {
      stack.pop();
    } else {
      stack.push({ kind: 'entity', token });
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\') {
      if (!isReservedEscapeTarget(text[i + 1])) {
        errors.push(`Invalid escape sequence at index ${i}: '\\' must be followed by a reserved character`);
      }
      i += 2;
      continue;
    }

    // Code spans: inside them only '`' and '\' are special; content is otherwise literal.
    if (ch === '`' && !inUrl()) {
      if (text.startsWith('```', i)) {
        const close = findCodeClose(text, i + 3, '```');
        if (close < 0) {
          errors.push(`Unclosed pre entity at index ${i}`);
          i += 3;
        } else {
          i = close + 3;
        }
      } else {
        const close = findCodeClose(text, i + 1, '`');
        if (close < 0) {
          errors.push(`Unclosed code entity at index ${i}`);
          i += 1;
        } else {
          i = close + 1;
        }
      }
      continue;
    }

    if (inUrl()) {
      if (ch === ')') {
        stack.pop();
      } else if (ch === '(' || ch === ']' || ch === '[') {
        // Allowed raw inside a URL except the structural ')' (handled above).
      }
      i += 1;
      continue;
    }

    if (ch === '*') { toggleEntity('*'); i += 1; continue; }
    if (ch === '~') { toggleEntity('~'); i += 1; continue; }
    if (ch === '|') {
      if (text[i + 1] === '|') { toggleEntity('||'); i += 2; continue; }
      errors.push(`Unescaped reserved character '|' at index ${i}`);
      i += 1;
      continue;
    }
    if (ch === '_') {
      if (text[i + 1] === '_') { toggleEntity('__'); i += 2; continue; }
      toggleEntity('_');
      i += 1;
      continue;
    }
    if (ch === '[') {
      stack.push({ kind: 'linkAwait' });
      i += 1;
      continue;
    }
    if (ch === ']') {
      if (top()?.kind === 'linkAwait') {
        if (text[i + 1] !== '(') {
          errors.push(`Link at index ${i} must be followed by '('`);
          stack.pop();
          i += 1;
        } else {
          // Replace the link-text frame with the URL frame (the '](' pair is one boundary).
          stack.pop();
          stack.push({ kind: 'linkUrl' });
          i += 2;
        }
      } else {
        errors.push(`Unescaped reserved character ']' at index ${i}`);
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === ')') {
      errors.push(`Unescaped reserved character '${ch}' at index ${i}`);
      i += 1;
      continue;
    }
    if (RESERVED.has(ch)) {
      errors.push(`Unescaped reserved character '${ch}' at index ${i}`);
    }
    i += 1;
  }

  for (const frame of stack) {
    errors.push(frame.kind === 'entity' ? `Unclosed '${frame.token}' entity` : 'Unclosed link');
  }
  return errors;
}

/** Find the closing code delimiter, honouring `\`` escapes. Returns -1 when unclosed. */
function findCodeClose(text: string, from: number, delimiter: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text.startsWith(delimiter, i)) return i;
    i += 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Outbound length enforcement
// ---------------------------------------------------------------------------

const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

/**
 * Index of the last position in `text[0..budget]` at which the string is "safe to cut":
 * not in the middle of an escape sequence, a surrogate pair, an entity, a link text or a
 * link URL. Everything before that index is balanced MarkdownV2 on its own.
 */
function lastSafeCut(text: string, budget: number): number {
  const limit = Math.min(text.length, Math.max(0, budget));
  const stack: string[] = [];
  let lastSafe = 0;
  let i = 0;

  const recordIfBalanced = (position: number): void => {
    if (stack.length === 0) lastSafe = position;
  };

  while (i < limit) {
    const ch = text[i];

    if (ch === '\\') {
      // Consume the whole escape pair; a cut inside it would leave a dangling backslash.
      if (i + 1 < limit) {
        i += 2;
        recordIfBalanced(i);
      } else {
        i += 1;
      }
      continue;
    }

    if (HIGH_SURROGATE.test(ch) && i + 1 < limit && LOW_SURROGATE.test(text[i + 1])) {
      i += 2;
      recordIfBalanced(i);
      continue;
    }

    const previous = stack[stack.length - 1];
    if (ch === '`') {
      if (previous === '`') stack.pop();
      else stack.push('`');
    } else if (ch === '*') {
      if (previous === '*') stack.pop();
      else stack.push('*');
    } else if (ch === '~') {
      if (previous === '~') stack.pop();
      else stack.push('~');
    } else if (ch === '|' && text[i + 1] === '|') {
      if (previous === '||') stack.pop();
      else stack.push('||');
      i += 2;
      recordIfBalanced(i);
      continue;
    } else if (ch === '_' && text[i + 1] === '_') {
      if (previous === '__') stack.pop();
      else stack.push('__');
      i += 2;
      recordIfBalanced(i);
      continue;
    } else if (ch === '_') {
      if (previous === '_') stack.pop();
      else stack.push('_');
    } else if (ch === '[') {
      stack.push('[');
    } else if (ch === ']') {
      if (previous === '[') stack[stack.length - 1] = '[(';
    } else if (ch === '(') {
      if (previous === '[(') stack[stack.length - 1] = '(';
    } else if (ch === ')') {
      if (previous === '(') stack.pop();
    }

    i += 1;
    recordIfBalanced(i);
  }

  return lastSafe;
}

/**
 * Truncate a MarkdownV2 message below Telegram's 4096-character limit WITHOUT breaking it:
 * the cut happens only at a balanced position (never inside `\X`, an entity, a link, a URL
 * or a surrogate pair) and an explicit `…（完整内容见应用）` suffix is appended.
 *
 * The returned length is always `< TELEGRAM_MESSAGE_LIMIT` (we target limit - 1, so the
 * strict "under 4096" invariant holds even at the boundary).
 */
export function truncateMarkdownV2(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT): string {
  const cap = Math.max(1, Math.min(maxLength, TELEGRAM_MESSAGE_LIMIT) - 1);
  if (text.length <= cap) return text;
  const budget = Math.max(0, cap - TRUNCATION_SUFFIX.length);
  const cut = lastSafeCut(text, budget);
  const kept = text.slice(0, cut).replace(/\s+$/, '');
  return kept + TRUNCATION_SUFFIX;
}

/** Plain-text truncation for messages sent without a parse mode. */
export function truncatePlainText(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT): string {
  const cap = Math.max(1, Math.min(maxLength, TELEGRAM_MESSAGE_LIMIT) - 1);
  if (text.length <= cap) return text;
  let cut = Math.max(0, cap - TRUNCATION_SUFFIX.length);
  if (cut > 0 && HIGH_SURROGATE.test(text[cut - 1]) && LOW_SURROGATE.test(text[cut])) {
    cut -= 1;
  }
  return text.slice(0, cut).replace(/\s+$/, '') + TRUNCATION_SUFFIX;
}

/**
 * The outbound gate: called by the Telegram client for BOTH `sendMessage` and
 * `editMessageText`, so no handler can emit an oversized message.
 */
export function enforceTelegramMessageLimit(text: string, parseMode?: string | null): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length < TELEGRAM_MESSAGE_LIMIT) return value;
  return parseMode === 'MarkdownV2' ? truncateMarkdownV2(value) : truncatePlainText(value);
}
