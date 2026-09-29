import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@timemark/shared';

/**
 * Checkbox 103 acceptance: the STATELESS MCP server over the Streamable HTTP transport.
 *
 * A stateful in-memory fake stands in for `db.query`, so the WHOLE path runs against the real
 * dispatcher (checkbox 102), the real registry (100) and the real scoped-token authoriser (101):
 *   POST /api/mcp  ->  initialize / tools/list / tools/call / resources/list / resources/read
 *   tools/call     ->  validate -> authorise -> (confirm | execute) -> audit  (identical to /api/agent)
 *
 * The fake models the SHIPPED SQL for `agent_tokens`, `agent_audit_logs`, `agent_confirmations`
 * and the `events` read, including the conditional confirmation UPDATE.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { hashAgentToken } from '../services/agent-tokens.service.js';
import mcpRoutes, { MCP_PROTOCOL_VERSION, MCP_CAPABILITIES } from '../routes/mcp.js';
import agentRoutes from '../routes/agent.js';
import { csrfProtection } from '../middleware/csrf.js';

interface TokenRow {
  id: string;
  user_id: number;
  name: string;
  token_hash: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
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
  duration_ms: number | null;
  request_id: string | null;
}

interface ConfirmationRow {
  id: string;
  user_id: number;
  token_id: string | null;
  tool: string;
  args: unknown;
  status: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
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
  confirmations: [] as ConfirmationRow[],
  events: [] as EventRow[],
  deleteAttempts: 0,
};

let tokenSeq = 0;
let auditSeq = 0;
let confirmSeq = 0;

function uuid(prefix: number): string {
  return `00000000-0000-4000-8000-${String(prefix).padStart(12, '0')}`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function fakeQuery(text: string, params: unknown[] = []) {
  const sql = normalize(text);

  if (sql.startsWith('INSERT INTO agent_tokens')) {
    const [userId, name, tokenHash, scopes] = params as [number, string, string, string[]];
    const row: TokenRow = {
      id: uuid((tokenSeq += 1)),
      user_id: userId,
      name,
      token_hash: tokenHash,
      scopes,
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
      expires_at: null,
    };
    state.tokens.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (sql.includes('FROM agent_tokens WHERE token_hash = $1')) {
    const [hash] = params as [string];
    const row = state.tokens.find((token) => token.token_hash === hash);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('UPDATE agent_tokens SET last_used_at = now()')) {
    const [id] = params as [string];
    const row = state.tokens.find((token) => token.id === id);
    if (row) row.last_used_at = new Date().toISOString();
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('INSERT INTO agent_audit_logs')) {
    const [userId, tokenId, tool, argsRedacted, decision, result, errorCode, durationMs, requestId] = params as [
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
      duration_ms: durationMs ?? null,
      request_id: requestId ?? null,
    };
    state.audits.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE agent_audit_logs SET result = $2')) {
    const [auditId, result, errorCode, durationMs] = params as [string, string, string | null, number | null];
    const row = state.audits.find((audit) => audit.id === auditId);
    if (row) {
      row.result = result;
      row.error_code = errorCode;
      row.duration_ms = durationMs;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('SELECT id FROM agent_audit_logs WHERE request_id = $1')) {
    const [requestId] = params as [string];
    const row = state.audits.find((audit) => audit.request_id === requestId);
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('INSERT INTO agent_confirmations')) {
    const [userId, tokenId, tool, argsJson, ttlSec] = params as [number, string | null, string, string, number];
    const now = Date.now();
    const row: ConfirmationRow = {
      id: uuid((confirmSeq += 1)),
      user_id: userId,
      token_id: tokenId,
      tool,
      args: JSON.parse(argsJson),
      status: 'pending',
      created_at: new Date(now),
      expires_at: new Date(now + ttlSec * 1000),
      consumed_at: null,
    };
    state.confirmations.push(row);
    return { rows: [{ id: row.id, expires_at: row.expires_at }], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE agent_confirmations SET status = 'consumed'")) {
    const [id, userId] = params as [string, number];
    const hasPendingGuard = sql.includes("status = 'pending'");
    const hasTtlGuard = sql.includes('expires_at > now()');
    const row = state.confirmations.find(
      (confirmation) =>
        confirmation.id === id &&
        confirmation.user_id === userId &&
        (!hasPendingGuard || confirmation.status === 'pending') &&
        (!hasTtlGuard || confirmation.expires_at.getTime() > Date.now()),
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.status = 'consumed';
    row.consumed_at = new Date();
    return { rows: [{ id: row.id, tool: row.tool, args: row.args }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT status, (expires_at <= now()) AS expired FROM agent_confirmations')) {
    const [id, userId] = params as [string, number];
    const row = state.confirmations.find((confirmation) => confirmation.id === id && confirmation.user_id === userId);
    if (!row) return { rows: [], rowCount: 0 };
    return { rows: [{ status: row.status, expired: row.expires_at.getTime() <= Date.now() }], rowCount: 1 };
  }
  if (sql.includes('FROM events WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as [number, number];
    const row = state.events.find((event) => event.id === id && event.user_id === userId);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('DELETE FROM events')) {
    // Phase-1 of a confirmation MUST NOT reach this branch; the counter proves nothing mutated.
    state.deleteAttempts += 1;
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unexpected SQL in fake db: ${sql}`);
}

function rawToken(seed: string): string {
  return `tmt_${seed.repeat(64).slice(0, 64)}`;
}

function seedToken(input: { raw: string; scopes: string[]; userId?: number; revoked?: boolean }): TokenRow {
  const row: TokenRow = {
    id: uuid((tokenSeq += 1)),
    user_id: input.userId ?? 1,
    name: 'seeded',
    token_hash: hashAgentToken(input.raw),
    scopes: input.scopes,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: input.revoked ? new Date().toISOString() : null,
    expires_at: null,
  };
  state.tokens.push(row);
  return row;
}

function seedEvent(id: number, userId: number, name = 'dentist'): EventRow {
  const row: EventRow = {
    id,
    user_id: userId,
    name,
    type: 'medical',
    date: '2026-10-05',
    calendar_type: 'gregorian',
    person_name: null,
    next_occurrence: null,
  };
  state.events.push(row);
  return row;
}

function mcpApp() {
  const app = new Hono<{ Variables: { user: User } }>();
  app.route('/api/mcp', mcpRoutes);
  return app;
}

function authHeader(raw: string): Record<string, string> {
  return { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json' };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  return mcpApp().request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function rpc(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

beforeEach(() => {
  state.tokens = [];
  state.audits = [];
  state.confirmations = [];
  state.events = [];
  state.deleteAttempts = 0;
  tokenSeq = 0;
  auditSeq = 0;
  confirmSeq = 0;
  mockQuery.mockReset();
  mockQuery.mockImplementation(fakeQuery);
  process.env.MCP_ENABLED = 'true';
});

describe('transport gate: disabled / missing / invalid / revoked', () => {
  it('is DISABLED when MCP_ENABLED is unset, even with a valid token', async () => {
    const raw = rawToken('g');
    seedToken({ raw, scopes: ['admin'] });
    delete process.env.MCP_ENABLED;

    const res = await post(rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION }), authHeader(raw));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe('mcp_disabled');
  });

  it('rejects a MISSING token (no token configured) with 401', async () => {
    const res = await post(rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.message).toBe('missing_token');
  });

  it('rejects an INVALID (unknown) token with 401', async () => {
    const res = await post(rpc('tools/list', {}), authHeader(rawToken('x')));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('invalid_token');
  });

  it('rejects a REVOKED token on tools/call with 401 + a denied audit row', async () => {
    const raw = rawToken('r');
    seedToken({ raw, scopes: ['read'], revoked: true });
    seedEvent(1, 1);

    const res = await post(rpc('tools/call', { name: 'get_event', arguments: { eventId: 1 } }), authHeader(raw));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe('token_revoked');
    expect(state.audits.some((audit) => audit.decision === 'denied' && audit.error_code === 'token_revoked')).toBe(true);
  });
});

describe('initialize', () => {
  it('returns the protocol version + capabilities + serverInfo', async () => {
    const raw = rawToken('i');
    seedToken({ raw, scopes: ['read'] });

    const res = await post(rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION }), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.capabilities).toEqual(MCP_CAPABILITIES);
    expect(body.result.capabilities).toMatchObject({ tools: { listChanged: false }, resources: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe('timemark');
  });

  it('echoes a supported client protocol version', async () => {
    const raw = rawToken('i2');
    seedToken({ raw, scopes: ['read'] });
    const res = await post(rpc('initialize', { protocolVersion: '2025-03-26' }), authHeader(raw));
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-03-26');
  });
});

describe('tools/list filtered by the token scope', () => {
  it('a read token sees read tools but NOT write/destructive tools; admin sees them', async () => {
    const readRaw = rawToken('rl');
    seedToken({ raw: readRaw, scopes: ['read'] });
    const adminRaw = rawToken('ad');
    seedToken({ raw: adminRaw, scopes: ['admin'] });

    const readRes = await post(rpc('tools/list', {}), authHeader(readRaw));
    expect(readRes.status).toBe(200);
    const readTools = ((await readRes.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }> } }).result.tools;
    const readNames = readTools.map((tool) => tool.name);
    expect(readNames).toContain('list_events');
    expect(readNames).toContain('get_event');
    expect(readNames).not.toContain('create_event');
    expect(readNames).not.toContain('delete_event');
    expect(readNames).not.toContain('send_digest');
    // The registry's JSON Schema + annotations ride along.
    const getEvent = readTools.find((tool) => tool.name === 'get_event');
    expect(getEvent?.inputSchema).toMatchObject({ type: 'object' });
    expect(getEvent?.annotations.readOnlyHint).toBe(true);

    const adminRes = await post(rpc('tools/list', {}), authHeader(adminRaw));
    const adminNames = ((await adminRes.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    expect(adminNames).toContain('delete_event');
    expect(adminNames).toContain('create_event');
  });
});

describe('tools/call', () => {
  it('an ALLOWED read tool executes and returns the audit row id', async () => {
    const raw = rawToken('ex');
    seedToken({ raw, scopes: ['read'] });
    seedEvent(1, 1, 'dentist');

    const res = await post(rpc('tools/call', { name: 'get_event', arguments: { eventId: 1 } }), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; structuredContent: { status: string; auditId?: string; data?: { name?: string } } };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.status).toBe('executed');
    expect(body.result.structuredContent.data?.name).toBe('dentist');

    const auditId = body.result.structuredContent.auditId;
    expect(typeof auditId).toBe('string');
    const auditRow = state.audits.find((audit) => audit.id === auditId);
    expect(auditRow).toBeDefined();
    expect(auditRow?.decision).toBe('allowed');
    expect(auditRow?.result).toBe('ok');
    expect(auditRow?.tool).toBe('get_event');
  });

  it('REFUSES a tool outside the token scope with a JSON-RPC error + a denied audit row', async () => {
    const raw = rawToken('sd');
    seedToken({ raw, scopes: ['read'] });

    const res = await post(rpc('tools/call', { name: 'create_event', arguments: { name: 'x', date: '2026-10-05' } }), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown; error: { code: number; message: string; data: { error: string } } };
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32003);
    expect(body.error.message).toBe('scope_denied');
    expect(body.error.data.error).toBe('scope_denied');
    expect(state.audits.some((audit) => audit.decision === 'denied' && audit.error_code === 'scope_denied')).toBe(true);
  });

  it('an UNKNOWN tool returns a JSON-RPC error', async () => {
    const raw = rawToken('ut');
    seedToken({ raw, scopes: ['admin'] });
    const res = await post(rpc('tools/call', { name: 'not_a_tool', arguments: {} }), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; data: { error: string } } };
    expect(body.error.data.error).toBe('unknown_tool');
  });
});

describe('confirmation protocol (requiresConfirmation never auto-runs)', () => {
  it('delete_event surfaces confirm_required and mutates nothing', async () => {
    const raw = rawToken('cf');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(1, 1, 'dentist');

    const res = await post(rpc('tools/call', { name: 'delete_event', arguments: { eventId: 1 } }), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        structuredContent: { status: string; confirmationId: string; preview: { tool: string; args: unknown }; auditId?: string };
      };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.status).toBe('confirm_required');
    expect(body.result.structuredContent.confirmationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.result.structuredContent.preview.tool).toBe('delete_event');
    expect(typeof body.result.structuredContent.auditId).toBe('string');

    // NOTHING mutated: the event survives and no DELETE statement ran.
    expect(state.events).toHaveLength(1);
    expect(state.deleteAttempts).toBe(0);
    expect(state.confirmations).toHaveLength(1);
    expect(state.audits.filter((audit) => audit.decision === 'confirm_required')).toHaveLength(1);
    expect(state.audits.some((audit) => audit.decision === 'allowed')).toBe(false);
  });
});

describe('unknown JSON-RPC method is an error, not a 500', () => {
  it('returns -32601 with HTTP 200', async () => {
    const raw = rawToken('um');
    seedToken({ raw, scopes: ['read'] });
    const res = await post(rpc('tools/frobnicate', {}), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('method_not_found');
  });

  it('an unparsable body returns -32700, never a 500', async () => {
    const raw = rawToken('pe');
    seedToken({ raw, scopes: ['read'] });
    const res = await mcpApp().request('/api/mcp', {
      method: 'POST',
      headers: authHeader(raw),
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe('resources seam for checkbox 104', () => {
  it('resources/list returns a valid (empty) list', async () => {
    const raw = rawToken('rs');
    seedToken({ raw, scopes: ['read'] });
    const res = await post(rpc('resources/list', {}), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { resources: unknown[] } };
    expect(Array.isArray(body.result.resources)).toBe(true);
    expect(body.result.resources).toHaveLength(0);
  });

  it('resources/read returns a well-formed resource-not-found', async () => {
    const raw = rawToken('rr');
    seedToken({ raw, scopes: ['read'] });
    const res = await post(rpc('resources/read', { uri: 'timemark://today' }), authHeader(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toBe('resource_not_found');
  });
});

describe('stateless: no session coupling', () => {
  it('two fresh POSTs with the same token behave identically with NO prior initialize', async () => {
    const raw = rawToken('st');
    seedToken({ raw, scopes: ['read'] });

    const first = await post(rpc('tools/list', {}, 1), authHeader(raw));
    const second = await post(rpc('tools/list', {}, 2), authHeader(raw));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { result: unknown };
    const b = (await second.json()) as { result: unknown };
    // Same tool set, same order: the second request needed nothing from the first.
    expect(a.result).toEqual(b.result);

    // A tools/call also works with no prior initialize (no initialize-before-call coupling).
    seedEvent(1, 1);
    const call = await mcpApp().request('/api/mcp', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify(rpc('tools/call', { name: 'get_event', arguments: { eventId: 1 } })),
    });
    expect(call.status).toBe(200);
    expect(((await call.json()) as { result: { structuredContent: { status: string } } }).result.structuredContent.status).toBe('executed');
  });
});

describe('CSRF integration: narrow exemption for /api/mcp only', () => {
  function csrfApp() {
    const app = new Hono<{ Variables: { user: User } }>();
    app.use('*', csrfProtection());
    app.route('/api/mcp', mcpRoutes);
    app.route('/api/agent', agentRoutes);
    return app;
  }

  it('a compliant MCP client (Bearer, no X-Requested-With) reaches the handler', async () => {
    const raw = rawToken('cs');
    seedToken({ raw, scopes: ['read'] });
    const res = await csrfApp().request('/api/mcp', {
      method: 'POST',
      headers: authHeader(raw), // no Origin, no Referer, no X-Requested-With
      body: JSON.stringify(rpc('tools/list', {})),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(Array.isArray(body.result.tools)).toBe(true);
  });

  it('the SAME request without a Bearer token is still rejected by CSRF (403)', async () => {
    const res = await csrfApp().request('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no Origin, no Bearer, no X-Requested-With
      body: JSON.stringify(rpc('tools/list', {})),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Missing origin or authorization');
  });

  it('a normal browser-originated POST elsewhere (Bearer, no X-Requested-With) is STILL blocked', async () => {
    const raw = rawToken('nb');
    seedToken({ raw, scopes: ['read'] });
    const res = await csrfApp().request('/api/agent/actions/get_event', {
      method: 'POST',
      headers: authHeader(raw), // no Origin, no Referer, no X-Requested-With
      body: JSON.stringify({ args: { eventId: 1 } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Missing origin or authorization');
  });
});
