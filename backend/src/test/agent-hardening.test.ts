import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { User } from '@timemark/shared';

/**
 * Task 110 acceptance: hardening the agent / MCP surface.
 *
 *  (a) rug-pull defence: the registry sha256 pin, drift FAILURE + default-path reporting
 *  (b) per-token rate limits (minute + daily) and the AGENT_TOOLS_ENABLED kill switch on BOTH
 *      the action API and MCP
 *  (c) agent_audit_logs retention (365 days, redacted arguments)
 *  (d) URL-argument rejection + no outbound HTTP from any tool handler
 *  (e) docs/AGENT.md sections + the NOT-allowed list
 *  plus the recorded 103/104 gaps: revoked/expired credentials are re-checked on the read
 *  gates (GET /tools, tools/list, resources/read), not only on tools/call.
 *
 * A stateful in-memory fake stands in for `db.query`; the fixed-window `INSERT INTO
 * rate_limits` statement is modelled faithfully so the real PostgreSQL limiter path (not just
 * the in-memory fallback) is exercised.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { AGENT_TOOLS } from '@timemark/shared';
import {
  AGENT_TOOL_REGISTRY_SHA256,
  agentRegistryDriftSink,
  computeAgentToolRegistryHash,
  verifyAgentToolRegistry,
} from '../services/agent/registry-integrity.service.js';
import {
  AGENT_RATE_LIMIT_DAILY_MAX,
  AGENT_RATE_LIMIT_MAX,
  resetAgentRateLimitMemory,
} from '../services/agent/rate-limit.service.js';
import { hashAgentToken, redactAgentArgs } from '../services/agent-tokens.service.js';
import { findHttpUrlArgument, invokeTool } from '../services/agent/dispatch.service.js';
import { purgeLogTable, RETENTION_DAYS } from '../services/retention.service.js';
import agentRoutes from '../routes/agent.js';
import mcpRoutes from '../routes/mcp.js';

interface TokenRow {
  id: string;
  user_id: number;
  token_hash: string;
  scopes: string[];
  revoked_at: string | null;
  expires_at: string | null;
}

interface AuditRow {
  id: string;
  user_id: number | null;
  token_id: string | null;
  tool: string;
  args_redacted: unknown;
  decision: string;
  result: string | null;
  error_code: string | null;
  request_id: string | null;
  created_at: Date;
}

interface EventRow {
  id: number;
  user_id: number;
  name: string;
  type: string;
  date: string;
  calendar_type: string;
  person_name: string | null;
  next_occurrence: string | null;
}

const state = {
  tokens: [] as TokenRow[],
  audits: [] as AuditRow[],
  events: [] as EventRow[],
  rateWindows: new Map<string, { count: number; windowStart: number }>(),
  sqlLog: [] as string[],
};

let tokenSeq = 0;
let auditSeq = 0;

function uuid(prefix: number): string {
  return `00000000-0000-4000-8000-${String(prefix).padStart(12, '0')}`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function fakeQuery(text: string, params: unknown[] = []) {
  const sql = normalize(text);
  state.sqlLog.push(sql);

  if (sql.includes('FROM agent_tokens WHERE token_hash = $1')) {
    const [hash] = params as [string];
    const row = state.tokens.find((token) => token.token_hash === hash);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('UPDATE agent_tokens SET last_used_at = now()')) {
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO agent_audit_logs')) {
    const [userId, tokenId, tool, argsRedacted, decision, result, errorCode, , requestId] = params as [
      number | null,
      string | null,
      string,
      string,
      string,
      string | null,
      string | null,
      number | null,
      string | null,
    ];
    const row: AuditRow = {
      id: String((auditSeq += 1)),
      user_id: userId,
      token_id: tokenId,
      tool,
      args_redacted: JSON.parse(argsRedacted),
      decision,
      result: result ?? null,
      error_code: errorCode ?? null,
      request_id: requestId ?? null,
      created_at: new Date(),
    };
    state.audits.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE agent_audit_logs SET result = $2')) {
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id FROM agent_audit_logs WHERE request_id = $1')) {
    const [requestId] = params as [string];
    const row = state.audits.find((audit) => audit.request_id === requestId);
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('INSERT INTO rate_limits')) {
    // Faithful fixed-window model of the shipped ON CONFLICT statement: count resets when the
    // window has elapsed, otherwise increments; window_start only moves on reset.
    const [key, , windowSecondsRaw] = params as [string, number, number];
    const windowMs = Number(windowSecondsRaw) * 1000;
    const now = Date.now();
    const existing = state.rateWindows.get(key);
    if (!existing || existing.windowStart + windowMs <= now) {
      state.rateWindows.set(key, { count: 1, windowStart: now });
      return { rows: [{ count: 1, window_start: new Date(now) }], rowCount: 1 };
    }
    existing.count += 1;
    return { rows: [{ count: existing.count, window_start: new Date(existing.windowStart) }], rowCount: 1 };
  }
  if (sql.startsWith('DELETE FROM agent_audit_logs WHERE created_at < $1')) {
    const [cutoff] = params as [Date];
    const before = state.audits.length;
    state.audits = state.audits.filter((audit) => !(audit.created_at.getTime() < cutoff.getTime()));
    return { rows: [], rowCount: before - state.audits.length };
  }
  if (sql.includes('FROM events WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as [number, number];
    const row = state.events.find((event) => event.id === id && event.user_id === userId);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }

  throw new Error(`unexpected SQL in fake db: ${sql}`);
}

function rawToken(seed: string): string {
  return `tmt_${seed.repeat(64).slice(0, 64)}`;
}

function seedToken(input: {
  raw: string;
  scopes: string[];
  userId?: number;
  revoked?: boolean;
  expired?: boolean;
}): TokenRow {
  const row: TokenRow = {
    id: uuid((tokenSeq += 1)),
    user_id: input.userId ?? 1,
    token_hash: hashAgentToken(input.raw),
    scopes: input.scopes,
    revoked_at: input.revoked ? new Date(Date.now() - 60_000).toISOString() : null,
    expires_at: input.expired ? new Date(Date.now() - 60_000).toISOString() : null,
  };
  state.tokens.push(row);
  return row;
}

function seedEvent(id: number, userId = 1, name = 'dentist'): EventRow {
  const row: EventRow = {
    id,
    user_id: userId,
    name,
    type: 'other',
    date: '2026-10-05',
    calendar_type: 'gregorian',
    person_name: null,
    next_occurrence: null,
  };
  state.events.push(row);
  return row;
}

function auditRow(): AuditRow {
  return {
    id: '0',
    user_id: 1,
    token_id: null,
    tool: 'get_event',
    args_redacted: {},
    decision: 'allowed',
    result: 'ok',
    error_code: null,
    request_id: null,
    created_at: new Date(),
  };
}

function agentApp() {
  const app = new Hono<{ Variables: { user: User } }>();
  app.route('/', agentRoutes);
  return app;
}

function mcpApp() {
  const app = new Hono<{ Variables: { user: User } }>();
  app.route('/api/mcp', mcpRoutes);
  return app;
}

function authHeader(raw: string): Record<string, string> {
  return { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json' };
}

function rpc(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

async function mcpPost(body: unknown, headers: Record<string, string> = {}) {
  return mcpApp().request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function actionRequest(app: Hono<{ Variables: { user: User } }>, tool: string, args: unknown, raw: string) {
  return app.request(`/actions/${tool}`, {
    method: 'POST',
    headers: authHeader(raw),
    body: JSON.stringify({ args }),
  });
}

/** URL-valued argument cases shared by the acceptance test and the fetch-spy test. */
const URL_CASES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['create_document', { title: 'https://evil.example/steal', kind: 'passport' }],
  ['log_interaction', { contactId: 1, kind: 'call', summary: 'https://evil.example/steal' }],
  ['send_digest', { period: 'https://evil.example/steal' }],
];

const DISPATCH_SOURCE = readFileSync(new URL('../services/agent/dispatch.service.ts', import.meta.url), 'utf8');
const REGISTRY_INTEGRITY_SOURCE = readFileSync(
  new URL('../services/agent/registry-integrity.service.ts', import.meta.url),
  'utf8',
);
const TOOL_HANDLERS_SOURCE = readFileSync(
  new URL('../services/agent/tool-handlers.ts', import.meta.url),
  'utf8',
);

const SAVED_AGENT_TOOLS_ENABLED = process.env.AGENT_TOOLS_ENABLED;
const SAVED_MCP_ENABLED = process.env.MCP_ENABLED;

beforeEach(() => {
  state.tokens = [];
  state.audits = [];
  state.events = [];
  state.rateWindows = new Map();
  state.sqlLog = [];
  tokenSeq = 0;
  auditSeq = 0;
  mockQuery.mockReset();
  mockQuery.mockImplementation(fakeQuery);
  resetAgentRateLimitMemory();
  process.env.MCP_ENABLED = 'true';
  delete process.env.AGENT_TOOLS_ENABLED;
});

afterEach(() => {
  if (SAVED_AGENT_TOOLS_ENABLED === undefined) delete process.env.AGENT_TOOLS_ENABLED;
  else process.env.AGENT_TOOLS_ENABLED = SAVED_AGENT_TOOLS_ENABLED;
  if (SAVED_MCP_ENABLED === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = SAVED_MCP_ENABLED;
});

describe('110(a) rug-pull defence: registry hash pin + drift reporting', () => {
  it('the pinned sha256 matches the live registry', () => {
    expect(computeAgentToolRegistryHash()).toBe(AGENT_TOOL_REGISTRY_SHA256);
    expect(verifyAgentToolRegistry().ok).toBe(true);
  });

  it('a mutated registry FAILS the check and reports the drift through the DEFAULT path', () => {
    const sinkSpy = vi.spyOn(agentRegistryDriftSink, 'report');
    try {
      const tampered = AGENT_TOOLS.map((tool, index) =>
        index === 0 ? { ...tool, description: `${tool.description} (tampered)` } : tool,
      );
      const result = verifyAgentToolRegistry(tampered);

      expect(result.ok).toBe(false);
      expect(result.actual).not.toBe(AGENT_TOOL_REGISTRY_SHA256);
      expect(result.expected).toBe(AGENT_TOOL_REGISTRY_SHA256);
      // The default reporter ran: one alert carrying both digests + the tool count.
      expect(sinkSpy).toHaveBeenCalledTimes(1);
      expect(sinkSpy.mock.calls[0][0]).toMatchObject({
        expected: AGENT_TOOL_REGISTRY_SHA256,
        actual: result.actual,
        toolCount: AGENT_TOOLS.length,
      });
    } finally {
      sinkSpy.mockRestore();
    }
  });

  it('schema / flag mutations are drift too, and the check never throws', () => {
    const widened = AGENT_TOOLS.map((tool, index) => (index === 0 ? { ...tool, destructive: !tool.destructive } : tool));
    const noop = (): void => {};
    expect(verifyAgentToolRegistry(widened, noop).ok).toBe(false);
    expect(verifyAgentToolRegistry([], noop).ok).toBe(false);
  });

  it('the alert sink logs at error level; the dispatcher checks once at module load', () => {
    expect(REGISTRY_INTEGRITY_SOURCE).toContain('log.error(');
    expect(DISPATCH_SOURCE).toContain('verifyAgentToolRegistry()');
    // DECISION: drift is logged/alerted, never a request-time hard failure.
    expect(DISPATCH_SOURCE).not.toContain('throw');
  });
});

describe('110(b) kill switch: AGENT_TOOLS_ENABLED=false disables BOTH surfaces', () => {
  it('refuses the action API routes and every MCP method with the same 503', async () => {
    const raw = rawToken('ks');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(1);
    process.env.AGENT_TOOLS_ENABLED = 'false';

    const app = agentApp();
    const tools = await app.request('/tools', { headers: authHeader(raw) });
    expect(tools.status).toBe(503);
    expect(((await tools.json()) as { error: string }).error).toBe('agent_tools_disabled');

    const action = await actionRequest(app, 'get_event', { eventId: 1 }, raw);
    expect(action.status).toBe(503);
    expect(((await action.json()) as { error: string }).error).toBe('agent_tools_disabled');

    const confirm = await app.request('/confirm/00000000-0000-4000-8000-000000000001', {
      method: 'POST',
      headers: authHeader(raw),
    });
    expect(confirm.status).toBe(503);

    for (const body of [
      rpc('tools/call', { name: 'get_event', arguments: { eventId: 1 } }),
      rpc('tools/list', {}),
      rpc('initialize', { protocolVersion: '2025-06-18' }),
    ]) {
      const res = await mcpPost(body, authHeader(raw));
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: { code: number; message: string } };
      expect(json.error.code).toBe(-32000);
      expect(json.error.message).toBe('agent_tools_disabled');
    }

    // Nothing reached a handler or the audit trail.
    expect(state.audits).toHaveLength(0);
    expect(state.sqlLog.some((sql) => sql.includes('FROM events'))).toBe(false);
  });

  it('is a kill switch, not an opt-in flag: unset / "true" keeps both surfaces live', async () => {
    const raw = rawToken('ko');
    seedToken({ raw, scopes: ['read'] });
    seedEvent(1);

    delete process.env.AGENT_TOOLS_ENABLED;
    const app = agentApp();
    const unsetTools = await app.request('/tools', { headers: authHeader(raw) });
    expect(unsetTools.status).toBe(200);
    const unsetMcp = await mcpPost(rpc('tools/list', {}), authHeader(raw));
    expect(unsetMcp.status).toBe(200);

    process.env.AGENT_TOOLS_ENABLED = 'true';
    const trueTools = await app.request('/tools', { headers: authHeader(raw) });
    expect(trueTools.status).toBe(200);
    const trueMcp = await mcpPost(rpc('tools/list', {}), authHeader(raw));
    expect(trueMcp.status).toBe(200);
  });
});

describe('110(b) per-token rate limits (minute + daily)', () => {
  it(`the ${AGENT_RATE_LIMIT_MAX + 1}st request in the minute window is refused with rate_limited_minute`, async () => {
    const raw = rawToken('rl');
    seedToken({ raw, scopes: ['read'] });
    seedEvent(1);
    const otherRaw = rawToken('ro');
    seedToken({ raw: otherRaw, scopes: ['read'] });
    const app = agentApp();

    for (let index = 0; index < AGENT_RATE_LIMIT_MAX; index += 1) {
      const res = await actionRequest(app, 'get_event', { eventId: 1 }, raw);
      expect(res.status).toBe(200);
    }

    const refused = await actionRequest(app, 'get_event', { eventId: 1 }, raw);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as {
      success: boolean;
      error: string;
      scope: string;
      message: string;
      retryAfterSeconds: number;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe('rate_limited_minute');
    expect(body.scope).toBe('minute');
    expect(body.message).toContain('每分钟');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.headers.get('Retry-After')).toBeTruthy();

    // Per-token isolation: a different token is untouched by the exhausted window.
    const other = await actionRequest(app, 'get_event', { eventId: 1 }, otherRaw);
    expect(other.status).toBe(200);
  });

  it('the daily cap trips at 1000 with rate_limited_daily, per token', async () => {
    const raw = rawToken('rd');
    seedToken({ raw, scopes: ['read'] });
    seedEvent(1);
    const otherRaw = rawToken('rdo');
    seedToken({ raw: otherRaw, scopes: ['read'] });
    const app = agentApp();

    const key = `rl:agent:tok:${hashAgentToken(raw)}:day`;
    state.rateWindows.set(key, { count: AGENT_RATE_LIMIT_DAILY_MAX - 1, windowStart: Date.now() });

    const allowed = await actionRequest(app, 'get_event', { eventId: 1 }, raw);
    expect(allowed.status).toBe(200);

    const refused = await actionRequest(app, 'get_event', { eventId: 1 }, raw);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: string; scope: string; message: string; retryAfterSeconds: number };
    expect(body.error).toBe('rate_limited_daily');
    expect(body.scope).toBe('daily');
    expect(body.message).toContain('每日');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    // Per-token isolation: the other token still has its own daily budget.
    const other = await actionRequest(app, 'get_event', { eventId: 1 }, otherRaw);
    expect(other.status).toBe(200);
  });

  it('MCP shares the same per-token limiter (JSON-RPC -32005 + HTTP 429)', async () => {
    const raw = rawToken('rm');
    seedToken({ raw, scopes: ['read'] });
    const key = `rl:agent:tok:${hashAgentToken(raw)}`;
    state.rateWindows.set(key, { count: AGENT_RATE_LIMIT_MAX - 1, windowStart: Date.now() });

    const allowed = await mcpPost(rpc('tools/list', {}), authHeader(raw));
    expect(allowed.status).toBe(200);

    const refused = await mcpPost(rpc('tools/list', {}), authHeader(raw));
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: { code: number; message: string; data: { scope: string } } };
    expect(body.error.code).toBe(-32005);
    expect(body.error.message).toBe('rate_limited_minute');
    expect(body.error.data.scope).toBe('minute');
    expect(refused.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('110(c) agent audit retention (365 days, redacted arguments)', () => {
  it('exposes the 365-day window for agent_audit_logs', () => {
    expect(RETENTION_DAYS.agentAuditLogs).toBe(365);
  });

  it('the purge removes audit rows older than 365 days and keeps newer ones', async () => {
    const now = Date.now();
    state.audits = [
      { ...auditRow(), id: 'old', created_at: new Date(now - 366 * 24 * 60 * 60 * 1000) },
      { ...auditRow(), id: 'new', created_at: new Date(now - 364 * 24 * 60 * 60 * 1000) },
    ];

    const deleted = await purgeLogTable('agent_audit_logs');
    expect(deleted).toBe(1);
    expect(state.audits.map((audit) => audit.id)).toEqual(['new']);
  });

  it('audit arguments are deep-redacted before they are ever stored', () => {
    const redacted = redactAgentArgs({
      apiKey: 'sk-live-abcdef',
      nested: { password: 'hunter2' },
      text: `token ${'tmt_' + 'a'.repeat(64)}`,
    });
    expect(redacted).not.toContain('sk-live-abcdef');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('tmt_');
  });
});

describe('110(d) no outbound HTTP: URL arguments are rejected', () => {
  it('rejects http(s) URL values for create_document, log_interaction and send_digest', async () => {
    const raw = rawToken('url');
    seedToken({ raw, scopes: ['admin'] });
    const app = agentApp();

    for (const [tool, args] of URL_CASES) {
      const res = await actionRequest(app, tool, args, raw);
      expect(res.status, `${tool} must reject a URL argument`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('url_argument_rejected');
    }

    // No handler ever ran for those calls: no document / interaction / digest SQL.
    expect(state.sqlLog.some((sql) => /INSERT INTO (documents|contact_interactions|digest)/i.test(sql))).toBe(false);
    expect(state.audits).toHaveLength(0);
  });

  it('rejects URL values at any depth, in arrays, and leaves ordinary prose alone', () => {
    expect(findHttpUrlArgument({ issuer: 'https://evil.example' })).toBe('issuer');
    expect(findHttpUrlArgument({ a: { b: ['safe', 'http://evil.example/x'] } })).toBe('a.b[1]');
    expect(findHttpUrlArgument({ note: 'see https://example.com for details' })).toBeNull();
    expect(findHttpUrlArgument({ count: 3, ok: true })).toBeNull();
    expect(findHttpUrlArgument(null)).toBeNull();
  });

  it('the HTTP_URL check runs before schema validation (uniform refusal incl. enum fields)', async () => {
    const raw = rawToken('urle');
    seedToken({ raw, scopes: ['admin'] });
    const app = agentApp();
    // `send_digest.period` is an enum; a URL must still be refused by the URL rule, not by
    // the enum, so every tool answers the same error.
    const res = await actionRequest(app, 'send_digest', { period: 'https://evil.example' }, raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('url_argument_rejected');
  });

  it('no handler performs an outbound fetch (spy + source guard)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('outbound HTTP attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      seedEvent(1);
      for (const [tool, args] of URL_CASES) {
        const outcome = await invokeTool({
          caller: { kind: 'session', userId: 1 },
          tool,
          rawArgs: args,
          requestId: null,
        });
        expect(outcome.status).toBe('denied');
        if (outcome.status === 'denied') expect(outcome.error).toBe('url_argument_rejected');
      }

      // A normal allowed call really runs the handler (get_event reads the fake DB) and still
      // performs no outbound call.
      const allowed = await invokeTool({
        caller: { kind: 'session', userId: 1 },
        tool: 'get_event',
        rawArgs: { eventId: 1 },
        requestId: null,
      });
      expect(allowed.status).toBe('executed');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tool-handlers.ts contains no HTTP client at all (source guard)', () => {
    for (const banned of ['fetch(', 'axios', 'node:http', 'node:https', 'undici', 'http.request', 'https.request']) {
      expect(TOOL_HANDLERS_SOURCE, `tool-handlers.ts must not contain ${banned}`).not.toContain(banned);
    }
  });
});

describe('110 open items: revoked/expired credentials re-checked on the READ gates', () => {
  it('GET /tools answers 401 token_revoked / token_expired (previously 200 + registry)', async () => {
    const revokedRaw = rawToken('rv');
    seedToken({ raw: revokedRaw, scopes: ['admin'], revoked: true });
    const expiredRaw = rawToken('ex');
    seedToken({ raw: expiredRaw, scopes: ['admin'], expired: true });
    const app = agentApp();

    const revoked = await app.request('/tools', { headers: authHeader(revokedRaw) });
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { error: string }).error).toBe('token_revoked');

    const expired = await app.request('/tools', { headers: authHeader(expiredRaw) });
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: string }).error).toBe('token_expired');
  });

  it('MCP tools/list and resources/read refuse revoked/expired with JSON-RPC -32001', async () => {
    const revokedRaw = rawToken('mrv');
    seedToken({ raw: revokedRaw, scopes: ['read'], revoked: true });
    const expiredRaw = rawToken('mex');
    seedToken({ raw: expiredRaw, scopes: ['read'], expired: true });

    const list = await mcpPost(rpc('tools/list', {}), authHeader(revokedRaw));
    expect(list.status).toBe(401);
    expect(((await list.json()) as { error: { code: number; message: string } }).error).toMatchObject({
      code: -32001,
      message: 'token_revoked',
    });

    const read = await mcpPost(rpc('resources/read', { uri: 'timemark://today' }), authHeader(expiredRaw));
    expect(read.status).toBe(401);
    expect(((await read.json()) as { error: { code: number; message: string } }).error).toMatchObject({
      code: -32001,
      message: 'token_expired',
    });
  });

  it('tools/call keeps the audited dispatcher path for a revoked token', async () => {
    const revokedRaw = rawToken('tcr');
    seedToken({ raw: revokedRaw, scopes: ['admin'], revoked: true });
    seedEvent(1);

    const res = await mcpPost(rpc('tools/call', { name: 'get_event', arguments: { eventId: 1 } }), authHeader(revokedRaw));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('token_revoked');
    expect(state.audits.some((audit) => audit.decision === 'denied' && audit.error_code === 'token_revoked')).toBe(true);
  });
});

describe('110(e) docs/AGENT.md', () => {
  const doc = readFileSync(new URL('../../../docs/AGENT.md', import.meta.url), 'utf8');

  it('contains the five required sections', () => {
    for (const heading of [
      '## 威胁模型（Threat model）',
      '## 权限范围（Scopes）',
      '## 确认流程（Confirmation flow）',
      '## 不可信内容围栏（Untrusted-content fencing）',
      '## 本地模型与 MCP 拓扑（Local-model / MCP topology）',
      '## 助手绝对不可以做的事（NOT allowed）',
    ]) {
      expect(doc, `missing section: ${heading}`).toContain(heading);
    }
  });

  it('spells out the NOT-allowed list explicitly', () => {
    for (const needle of [
      'no payments',
      'no external messaging to arbitrary recipients',
      'no credential access',
      'no bulk delete',
      'delete_event',
      'send_digest',
    ]) {
      expect(doc).toContain(needle);
    }
  });

  it('documents the mechanics this task shipped', () => {
    for (const needle of [
      'AGENT_TOOLS_ENABLED=false',
      'agent_tools_disabled',
      'MCP_AUTH_TOKEN',
      'rate_limited_minute',
      'rate_limited_daily',
      'agent_audit_logs',
      '365',
      'url_argument_rejected',
      'fenceUntrusted',
      'rug-pull',
      'sha256',
      'confirmationId',
      'timemark://',
    ]) {
      expect(doc, `missing documented mechanic: ${needle}`).toContain(needle);
    }
  });
});
