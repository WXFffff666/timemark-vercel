import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@timemark/shared';

/**
 * Checkbox 102 acceptance: the agent action API (`/api/agent`) with the two-phase confirmation
 * flow. A stateful in-memory fake stands in for `db.query`, so the WHOLE path runs against the
 * real dispatcher, the real registry and the real `delete_event` handler:
 *   validate -> authorise -> confirm (single-use, 2-min TTL) -> execute -> audit.
 *
 * The fake models the shipped SQL for `agent_tokens`, `agent_audit_logs`, `agent_confirmations`
 * and the `events` delete, including the conditional UPDATE that makes a second confirm fail.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { DOCUMENTED_AGENT_TOOL_NAMES } from '@timemark/shared';
import { hashAgentToken } from '../services/agent-tokens.service.js';
import { AGENT_TOOL_HANDLERS } from '../services/agent/tool-handlers.js';
import { confirmTool, invokeTool, listAgentToolsForScopes } from '../services/agent/dispatch.service.js';
import { CONFIRMATION_SQL, CONFIRMATION_TTL_MS } from '../services/agent/confirmations.service.js';
import { resetAgentRateLimitMemory } from '../services/agent/rate-limit.service.js';
import agentRoutes from '../routes/agent.js';

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
  date: string;
  type: string;
  calendar_type: string;
  person_name: string | null;
  next_occurrence: string | null;
}

const state = {
  tokens: [] as TokenRow[],
  audits: [] as AuditRow[],
  confirmations: [] as ConfirmationRow[],
  events: [] as EventRow[],
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
    // The fake mirrors the SHIPPED predicates: it only applies the `pending` / TTL guards when
    // the shipped SQL text actually contains them, so a mutated query is reproduced faithfully
    // (this is what makes the negative controls meaningful).
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
    return {
      rows: [{ status: row.status, expired: row.expires_at.getTime() <= Date.now() }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('DELETE FROM events')) {
    const [id, userId] = params as [string, string];
    const before = state.events.length;
    state.events = state.events.filter(
      (event) => !(String(event.id) === String(id) && String(event.user_id) === String(userId)),
    );
    return { rows: [], rowCount: before - state.events.length };
  }

  throw new Error(`unexpected SQL in fake db: ${sql}`);
}

function rawToken(seed: string): string {
  return `tmt_${seed.repeat(64).slice(0, 64)}`;
}

function seedToken(input: { raw: string; scopes: string[]; userId?: number }): TokenRow {
  const row: TokenRow = {
    id: uuid((tokenSeq += 1)),
    user_id: input.userId ?? 1,
    name: 'seeded',
    token_hash: hashAgentToken(input.raw),
    scopes: input.scopes,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
  };
  state.tokens.push(row);
  return row;
}

function seedEvent(id: number, userId: number, name = 'e'): EventRow {
  const row: EventRow = {
    id,
    user_id: userId,
    name,
    date: '2026-10-05',
    type: 'other',
    calendar_type: 'gregorian',
    person_name: null,
    next_occurrence: null,
  };
  state.events.push(row);
  return row;
}

function routeApp() {
  const app = new Hono<{ Variables: { user: User } }>();
  app.route('/', agentRoutes);
  return app;
}

function authHeader(raw: string): Record<string, string> {
  return { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json' };
}

function deleteCalls(): string[] {
  return mockQuery.mock.calls.map(([sql]) => sql as string).filter((sql) => sql.includes('DELETE FROM events'));
}

beforeEach(() => {
  state.tokens = [];
  state.audits = [];
  state.confirmations = [];
  state.events = [];
  tokenSeq = 0;
  auditSeq = 0;
  confirmSeq = 0;
  mockQuery.mockReset();
  mockQuery.mockImplementation(fakeQuery);
  resetAgentRateLimitMemory();
});

describe('registry binding', () => {
  it('binds every documented tool to exactly one handler', () => {
    expect(Object.keys(AGENT_TOOL_HANDLERS).sort()).toEqual([...DOCUMENTED_AGENT_TOOL_NAMES].sort());
  });
});

describe('GET /tools scope filtering', () => {
  it('a read token does NOT see destructive tools; an admin token sees them', async () => {
    const readRaw = rawToken('r');
    seedToken({ raw: readRaw, scopes: ['read'] });
    const adminRaw = rawToken('a');
    seedToken({ raw: adminRaw, scopes: ['admin'] });

    const app = routeApp();
    const readRes = await app.request('/tools', { headers: authHeader(readRaw) });
    expect(readRes.status).toBe(200);
    const readNames = ((await readRes.json()) as { data: { tools: Array<{ name: string }> } }).data.tools.map(
      (tool) => tool.name,
    );
    expect(readNames).toContain('list_events');
    expect(readNames).not.toContain('delete_event');
    expect(readNames).not.toContain('send_digest');
    expect(readNames).not.toContain('create_event');

    const adminRes = await app.request('/tools', { headers: authHeader(adminRaw) });
    const adminNames = ((await adminRes.json()) as { data: { tools: Array<{ name: string }> } }).data.tools.map(
      (tool) => tool.name,
    );
    expect(adminNames).toContain('delete_event');
    expect(adminNames).toContain('send_digest');

    // The pure helper agrees: a read grant never yields a destructive tool.
    expect(listAgentToolsForScopes(['read']).some((tool) => tool.destructive)).toBe(false);
    expect(listAgentToolsForScopes(['admin']).some((tool) => tool.destructive)).toBe(true);
  });
});

describe('two-phase confirmation (a),(b)', () => {
  it('(a) a destructive tool returns confirm_required and mutates nothing', async () => {
    const raw = rawToken('d');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(1, 1, 'dentist');

    const app = routeApp();
    const res = await app.request('/actions/delete_event', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: { eventId: 1 } }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      data: { status: string; confirmationId: string; preview: { tool: string; args: unknown } };
    };
    expect(body.data.status).toBe('confirm_required');
    expect(body.data.preview.tool).toBe('delete_event');
    expect(body.data.confirmationId).toMatch(/^[0-9a-f-]{36}$/);

    // NOTHING was deleted and no delete statement ran.
    expect(state.events).toHaveLength(1);
    expect(deleteCalls()).toHaveLength(0);
    // The decision is audited as confirm_required (never allowed).
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].decision).toBe('confirm_required');
  });

  it('(b) confirming executes once; a second confirm of the same id fails', async () => {
    const raw = rawToken('e');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(1, 1, 'dentist');

    const app = routeApp();
    const phase1 = await app.request('/actions/delete_event', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: { eventId: 1 } }),
    });
    const { data } = (await phase1.json()) as { data: { confirmationId: string } };

    const first = await app.request(`/confirm/${data.confirmationId}`, { method: 'POST', headers: authHeader(raw) });
    expect(first.status).toBe(200);
    expect(state.events).toHaveLength(0);
    expect(deleteCalls()).toHaveLength(1);

    const second = await app.request(`/confirm/${data.confirmationId}`, { method: 'POST', headers: authHeader(raw) });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error: string };
    expect(secondBody.error).toBe('confirmation_already_used');
    // Still exactly one delete - the replay ran nothing.
    expect(deleteCalls()).toHaveLength(1);

    // The executed confirm recorded an `allowed` audit row finalized to `ok`.
    const allowed = state.audits.filter((audit) => audit.decision === 'allowed');
    expect(allowed).toHaveLength(1);
    expect(allowed[0].result).toBe('ok');
  });

  it('single-use is enforced in the data layer: a concurrent double-confirm executes exactly once', async () => {
    const raw = rawToken('cc');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(11, 1, 'race');

    const app = routeApp();
    const phase1 = await app.request('/actions/delete_event', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: { eventId: 11 } }),
    });
    const { data } = (await phase1.json()) as { data: { confirmationId: string } };

    const [first, second] = await Promise.all([
      app.request(`/confirm/${data.confirmationId}`, { method: 'POST', headers: authHeader(raw) }),
      app.request(`/confirm/${data.confirmationId}`, { method: 'POST', headers: authHeader(raw) }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(deleteCalls()).toHaveLength(1);
    expect(state.events).toHaveLength(0);

    // The guarantee is the SQL, not JS: the claim is one conditional UPDATE that only matches a
    // still-pending, unexpired row. A worker cannot race this because the DB serialises it.
    expect(CONFIRMATION_SQL.claim).toContain("status = 'pending'");
    expect(CONFIRMATION_SQL.claim).toContain('expires_at > now()');
    expect(CONFIRMATION_SQL.claim).toContain("SET status = 'consumed'");
    expect(CONFIRMATION_TTL_MS).toBe(120_000);
  });
});

describe('confirmation TTL (c)', () => {
  it('(c) a confirmation older than 2 minutes is rejected', async () => {
    const raw = rawToken('t');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(1, 1, 'dentist');

    const app = routeApp();
    const phase1 = await app.request('/actions/delete_event', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: { eventId: 1 } }),
    });
    const { data } = (await phase1.json()) as { data: { confirmationId: string } };

    // Age the pending confirmation beyond the 2-minute TTL (the shipped default is 120s).
    expect(state.confirmations[0].expires_at.getTime() - state.confirmations[0].created_at.getTime()).toBe(120_000);
    state.confirmations[0].expires_at = new Date(Date.now() - 1000);

    const res = await app.request(`/confirm/${data.confirmationId}`, { method: 'POST', headers: authHeader(raw) });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('confirmation_expired');
    // Expired => nothing ran.
    expect(state.events).toHaveLength(1);
    expect(deleteCalls()).toHaveLength(0);
  });
});

describe('unknown tool (d)', () => {
  it('(d) an unknown tool name returns 404 and never reaches a handler', async () => {
    const raw = rawToken('u');
    seedToken({ raw, scopes: ['admin'] });

    const app = routeApp();
    const res = await app.request('/actions/not_a_tool', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_tool');
    expect(deleteCalls()).toHaveLength(0);
  });
});

describe('ownership denial (e) + deleted-between-phases QA', () => {
  it('(e) an argument targeting another user\'s entity is denied by the handler', async () => {
    const raw = rawToken('o');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(7, 2, 'someone else');

    const app = routeApp();
    const phase1 = await app.request('/actions/delete_event', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: { eventId: 7 } }),
    });
    const { data } = (await phase1.json()) as { data: { confirmationId: string } };

    const confirmed = await app.request(`/confirm/${data.confirmationId}`, {
      method: 'POST',
      headers: authHeader(raw),
    });
    expect(confirmed.status).toBe(404);
    const body = (await confirmed.json()) as { error: string; code: string };
    expect(body.error).toBe('目标已不存在');
    expect(body.code).toBe('target_not_found');
    // The foreign row survives (the handler's user_id guard held) and the audit says error.
    expect(state.events).toHaveLength(1);
    const errorAudit = state.audits.find((audit) => audit.result === 'error');
    expect(errorAudit?.error_code).toBe('target_not_found');
  });

  it('QA: confirming a target deleted between the two phases returns 目标已不存在 + error audit row', async () => {
    const raw = rawToken('q');
    seedToken({ raw, scopes: ['admin'] });
    seedEvent(9, 1, 'to be deleted');

    const app = routeApp();
    const phase1 = await app.request('/actions/delete_event', {
      method: 'POST',
      headers: authHeader(raw),
      body: JSON.stringify({ args: { eventId: 9 } }),
    });
    const { data } = (await phase1.json()) as { data: { confirmationId: string } };

    // The target vanishes between phases (deleted by another process / concurrent request).
    state.events = [];

    const confirmed = await app.request(`/confirm/${data.confirmationId}`, {
      method: 'POST',
      headers: authHeader(raw),
    });
    expect(confirmed.status).toBe(404);
    const body = (await confirmed.json()) as { error: string; code: string };
    expect(body.error).toBe('目标已不存在');
    expect(body.code).toBe('target_not_found');

    const errorAudit = state.audits.find((audit) => audit.decision === 'allowed' && audit.result === 'error');
    expect(errorAudit).toBeDefined();
    expect(errorAudit?.error_code).toBe('target_not_found');
  });
});

describe('session caller (in-app assistant shares the path)', () => {
  it('runs the same two-phase flow without a token and audits it', async () => {
    seedEvent(3, 1, 'session delete');

    const phase1 = await invokeTool({
      caller: { kind: 'session', userId: 1 },
      tool: 'delete_event',
      rawArgs: { eventId: 3 },
      requestId: 's-1',
    });
    expect(phase1.status).toBe('confirm_required');
    if (phase1.status !== 'confirm_required') throw new Error('expected confirm_required');
    expect(state.events).toHaveLength(1);

    const done = await confirmTool({
      caller: { kind: 'session', userId: 1 },
      confirmationId: phase1.confirmationId,
      requestId: 's-2',
    });
    expect(done.status).toBe('executed');
    if (done.status !== 'executed') throw new Error('expected executed');
    expect(done.result.ok).toBe(true);
    expect(state.events).toHaveLength(0);
  });
});
