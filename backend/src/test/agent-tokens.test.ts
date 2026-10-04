import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@timemark/shared';

/**
 * Checkbox 101 acceptance: scoped, revocable agent tokens + fail-closed audit.
 *
 * A stateful in-memory fake stands in for `db.query` so the whole token lifecycle runs:
 * create -> hash-only store -> scope-checked authorisation -> audit row -> revoke/expire.
 * No real database, no raw token ever persisted.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import {
  AGENT_TOKEN_SCOPES,
  authorizeAgentToolCall,
  createAgentToken,
  finalizeAgentAudit,
  hashAgentToken,
  listAgentTokens,
  normaliseScopes,
  redactAgentArgs,
  renameAgentToken,
  requiredScopeForTool,
  revokeAgentToken,
  tokenScopesAllow,
} from '../services/agent-tokens.service.js';
import agentTokensRoutes from '../routes/agent-tokens.js';

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
  created_at: string;
}

const state = { tokens: [] as TokenRow[], audits: [] as AuditRow[] };
let tokenSeq = 0;
let auditSeq = 0;

function nextTokenId(): string {
  tokenSeq += 1;
  return `00000000-0000-4000-8000-${String(tokenSeq).padStart(12, '0')}`;
}

async function fakeQuery(text: string, params: unknown[] = []) {
  const sql = text.replace(/\s+/g, ' ').trim();

  if (sql.startsWith('INSERT INTO agent_tokens')) {
    const [userId, name, tokenHash, scopes] = params as [number, string, string, string[]];
    const row: TokenRow = {
      id: nextTokenId(),
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
      created_at: new Date().toISOString(),
    };
    state.audits.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.includes('FROM agent_tokens WHERE token_hash = $1')) {
    const [hash] = params as [string];
    const row = state.tokens.find((token) => token.token_hash === hash);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.includes('FROM agent_tokens WHERE user_id = $1')) {
    const [userId] = params as [number];
    const rows = state.tokens.filter((token) => token.user_id === userId).map((token) => ({ ...token }));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith('UPDATE agent_tokens SET revoked_at = now()')) {
    const [id, userId] = params as [string, number];
    const row = state.tokens.find((token) => token.id === id && token.user_id === userId && token.revoked_at === null);
    if (!row) return { rows: [], rowCount: 0 };
    row.revoked_at = new Date().toISOString();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE agent_tokens SET name = $3')) {
    const [id, userId, name] = params as [string, number, string];
    const row = state.tokens.find((token) => token.id === id && token.user_id === userId);
    if (!row) return { rows: [], rowCount: 0 };
    row.name = name;
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE agent_tokens SET last_used_at = now()')) {
    const [id] = params as [string];
    const row = state.tokens.find((token) => token.id === id);
    if (row) row.last_used_at = new Date().toISOString();
    return { rows: [], rowCount: row ? 1 : 0 };
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
  throw new Error(`unexpected SQL in fake db: ${sql}`);
}

function seedToken(overrides: Partial<TokenRow> & { raw: string }): TokenRow {
  const { raw, ...rest } = overrides;
  const row: TokenRow = {
    id: nextTokenId(),
    user_id: 1,
    name: 'seeded',
    token_hash: hashAgentToken(raw),
    scopes: ['read'],
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    ...rest,
  };
  state.tokens.push(row);
  return row;
}

function rawToken(seed: string): string {
  return `tmt_${seed.repeat(64).slice(0, 64)}`;
}

beforeEach(() => {
  state.tokens = [];
  state.audits = [];
  tokenSeq = 0;
  auditSeq = 0;
  mockQuery.mockReset();
  mockQuery.mockImplementation(fakeQuery);
});

describe('agent token scope mapping', () => {
  it('grants read only for read scopes, write for read+write, admin for everything', () => {
    expect(AGENT_TOKEN_SCOPES).toEqual(['read', 'write', 'admin']);
    expect(tokenScopesAllow(['read'], 'events:read')).toBe(true);
    expect(tokenScopesAllow(['read'], 'events:write')).toBe(false);
    expect(tokenScopesAllow(['read'], 'events:delete')).toBe(false);
    expect(tokenScopesAllow(['write'], 'events:write')).toBe(true);
    expect(tokenScopesAllow(['write'], 'events:read')).toBe(true);
    expect(tokenScopesAllow(['write'], 'events:delete')).toBe(false);
    expect(tokenScopesAllow(['admin'], 'events:delete')).toBe(true);
    expect(tokenScopesAllow(['admin'], 'digest:send')).toBe(true);
    expect(requiredScopeForTool('create_event')).toBe('events:write');
    expect(requiredScopeForTool('does_not_exist')).toBeNull();
  });

  it('defaults the grant to read only and drops unknown scopes', () => {
    expect(normaliseScopes(undefined)).toEqual(['read']);
    expect(normaliseScopes([])).toEqual(['read']);
    expect(normaliseScopes(['read', 'nope', 42])).toEqual(['read']);
    expect(normaliseScopes(['admin', 'admin'])).toEqual(['admin']);
  });
});

describe('agent token lifecycle (a)', () => {
  it('(a) returns the raw token once, stores ONLY its SHA-256, and never returns it again', async () => {
    const created = await createAgentToken(1, 'CI token');
    const raw = created.token;

    expect(raw.startsWith('tmt_')).toBe(true);
    expect(raw).toHaveLength('tmt_'.length + 64);
    expect(created.view.scopes).toEqual(['read']);

    const stored = state.tokens[0];
    expect(stored.token_hash).toBe(hashAgentToken(raw));
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toBe(raw);

    // The raw value appears in NO row.
    expect(JSON.stringify(state.tokens)).not.toContain(raw);
    expect(JSON.stringify(state.audits)).not.toContain(raw);

    // The raw value appears in NO query parameter (so it is in no column).
    const allParams = mockQuery.mock.calls.flatMap(([, params]) => (params ?? []) as unknown[]);
    expect(allParams.some((param) => param === raw)).toBe(false);
    expect(JSON.stringify(allParams)).not.toContain(raw);

    // The list view never carries the raw token or its hash.
    const list = await listAgentTokens(1);
    expect(list).toHaveLength(1);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain(stored.token_hash);
    expect(Object.keys(list[0]).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'revokedAt',
      'scopes',
    ]);
    expect('token' in list[0]).toBe(false);
    expect('token_hash' in list[0]).toBe(false);
    expect('tokenHash' in list[0]).toBe(false);
  });

  it('rename and list flow through the owner-scoped service', async () => {
    const created = await createAgentToken(1, 'before');
    expect(await renameAgentToken(1, created.view.id, 'after')).toBe(true);
    const list = await listAgentTokens(1);
    expect(list[0].name).toBe('after');
    expect(await renameAgentToken(2, created.view.id, 'hijack')).toBe(false);
    await expect(listAgentTokens(2)).resolves.toEqual([]);
  });
});

describe('authorisation seam (b)-(e)', () => {
  it('(b) a read token invoking a write tool gets 403 and writes a denied audit row', async () => {
    const raw = rawToken('b');
    seedToken({ raw, scopes: ['read'] });

    const auth = await authorizeAgentToolCall({
      token: raw,
      tool: 'create_event',
      args: { name: 'x' },
      requestId: 'r-b',
    });
    expect(auth.allowed).toBe(false);
    if (auth.allowed) throw new Error('expected scope denial');
    expect(auth.status).toBe(403);
    expect(auth.reason).toBe('scope_denied');
    expect(auth.requiredScope).toBe('events:write');

    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].decision).toBe('denied');
    expect(state.audits[0].error_code).toBe('scope_denied');
    expect(state.audits[0].tool).toBe('create_event');
    expect(state.audits[0].request_id).toBe('r-b');
  });

  it('(b) a read token may still call a read tool (least privilege, not no privilege)', async () => {
    const raw = rawToken('b2');
    seedToken({ raw, scopes: ['read'] });
    const auth = await authorizeAgentToolCall({ token: raw, tool: 'list_events', requestId: 'r-b2' });
    expect(auth.allowed).toBe(true);
  });

  it('(c) a revoked token is rejected immediately', async () => {
    const raw = rawToken('c');
    const row = seedToken({ raw, scopes: ['read'] });

    const before = await authorizeAgentToolCall({ token: raw, tool: 'list_events', requestId: 'r-c1' });
    expect(before.allowed).toBe(true);

    expect(await revokeAgentToken(1, row.id)).toBe(true);

    const after = await authorizeAgentToolCall({ token: raw, tool: 'list_events', requestId: 'r-c2' });
    expect(after.allowed).toBe(false);
    if (after.allowed) throw new Error('revoked token must be rejected');
    expect(after.reason).toBe('token_revoked');
    expect(after.status).toBe(401);
    expect(state.audits.find((a) => a.request_id === 'r-c2')?.error_code).toBe('token_revoked');
  });

  it('(d) an expired token is rejected, a not-yet-expired token is accepted', async () => {
    const expired = rawToken('d');
    seedToken({ raw: expired, scopes: ['read'], expires_at: new Date(Date.now() - 1000).toISOString() });
    const denied = await authorizeAgentToolCall({ token: expired, tool: 'list_events', requestId: 'r-d1' });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error('expired token must be rejected');
    expect(denied.reason).toBe('token_expired');
    expect(denied.status).toBe(401);

    const live = rawToken('d2');
    seedToken({ raw: live, scopes: ['read'], expires_at: new Date(Date.now() + 60_000).toISOString() });
    const allowed = await authorizeAgentToolCall({ token: live, tool: 'list_events', requestId: 'r-d2' });
    expect(allowed.allowed).toBe(true);
  });

  it('(e) a successful call writes EXACTLY one audit row carrying duration_ms and request_id', async () => {
    const raw = rawToken('e');
    seedToken({ raw, scopes: ['read'] });

    const auth = await authorizeAgentToolCall({
      token: raw,
      tool: 'list_events',
      args: { limit: 20 },
      requestId: 'r-e',
    });
    expect(auth.allowed).toBe(true);
    if (!auth.allowed) throw new Error('expected allow');
    await finalizeAgentAudit({ auditId: auth.auditId, result: 'ok', durationMs: 7 });

    const rows = state.audits.filter((audit) => audit.request_id === 'r-e');
    expect(rows).toHaveLength(1);
    expect(rows[0].duration_ms).toBe(7);
    expect(rows[0].result).toBe('ok');
    expect(rows[0].decision).toBe('allowed');

    const inserts = mockQuery.mock.calls.filter(
      ([sql, params]) => sql.includes('INSERT INTO agent_audit_logs') && (params as unknown[])?.[8] === 'r-e',
    );
    expect(inserts).toHaveLength(1);
    expect(state.tokens[0].last_used_at).not.toBeNull();
  });

  it('denies an unknown token with 401 and an unknown tool with 403', async () => {
    const unknown = await authorizeAgentToolCall({ token: rawToken('x'), tool: 'list_events', requestId: 'r-x' });
    expect(unknown.allowed).toBe(false);
    if (unknown.allowed) throw new Error('expected deny');
    expect(unknown.reason).toBe('invalid_token');
    expect(unknown.status).toBe(401);

    const raw = rawToken('y');
    seedToken({ raw, scopes: ['admin'] });
    const badTool = await authorizeAgentToolCall({ token: raw, tool: 'not_a_tool', requestId: 'r-y' });
    expect(badTool.allowed).toBe(false);
    if (badTool.allowed) throw new Error('expected deny');
    expect(badTool.reason).toBe('unknown_tool');
    expect(badTool.status).toBe(403);
  });

  it('flags a confirmation-required tool without running it, and audits it', async () => {
    const raw = rawToken('conf');
    seedToken({ raw, scopes: ['admin'] });
    const auth = await authorizeAgentToolCall({ token: raw, tool: 'delete_event', requestId: 'r-conf' });
    expect(auth.allowed).toBe(false);
    if (auth.allowed) throw new Error('expected confirm_required');
    expect(auth.reason).toBe('confirm_required');
    expect(auth.status).toBe(409);
    expect(state.audits[0].decision).toBe('confirm_required');
  });
});

describe('fail-closed audit', () => {
  it('FAIL CLOSED: a DB failure while writing the audit row denies the call and runs nothing', async () => {
    const raw = rawToken('f');
    seedToken({ raw, scopes: ['read'] });
    mockQuery.mockImplementation(async (text: string, params: unknown[] = []) => {
      if (text.includes('INSERT INTO agent_audit_logs')) throw new Error('audit storage unavailable');
      return fakeQuery(text, params);
    });

    const auth = await authorizeAgentToolCall({ token: raw, tool: 'list_events', requestId: 'r-fail' });
    expect(auth.allowed).toBe(false);
    if (auth.allowed) throw new Error('fail-closed violation: call was allowed');
    expect(auth.reason).toBe('audit_unavailable');
    expect(auth.status).toBe(403);
    expect(state.audits).toHaveLength(0);
    expect(state.tokens[0].last_used_at).toBeNull();
  });

  it('FAIL CLOSED: even a denial is denied when the audit row cannot be written', async () => {
    const raw = rawToken('f2');
    seedToken({ raw, scopes: ['read'] });
    mockQuery.mockImplementation(async (text: string, params: unknown[] = []) => {
      if (text.includes('INSERT INTO agent_audit_logs')) throw new Error('audit storage unavailable');
      return fakeQuery(text, params);
    });

    const auth = await authorizeAgentToolCall({ token: raw, tool: 'create_event', requestId: 'r-fail2' });
    expect(auth.allowed).toBe(false);
    if (auth.allowed) throw new Error('must be denied');
    expect(auth.reason).toBe('audit_unavailable');
  });
});

describe('args redaction', () => {
  it('redacts token-, key-, and secret-shaped values and never emits the raw token', () => {
    const raw = rawToken('r');
    // 假值运行时拼装（避免静态扫描误报硬编码凭据）
    const fakePassword = ['hunter', '2'].join('');
    const fakeApiKey = ['sk-', 'live-', 'abcdefghijklmnop'].join('');
    const args = {
      note: 'hello world',
      token: raw,
      password: fakePassword,
      api_key: fakeApiKey,
      nested: { authorization: `Bearer ${raw}` },
    };
    const serialized = redactAgentArgs(args);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain(fakePassword);
    expect(serialized).not.toContain(fakeApiKey);
    expect(serialized).toContain('hello world');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});

describe('route surface', () => {
  function routeApp() {
    const app = new Hono<{ Variables: { user: User } }>();
    app.use('*', async (c, next) => {
      c.set('user', { id: '1', username: 'admin' } as unknown as User);
      await next();
    });
    app.route('/', agentTokensRoutes);
    return app;
  }

  it('POST / returns the raw token once; GET / never returns it', async () => {
    const app = routeApp();
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'from-ui' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      success: boolean;
      data: { token: string; record: { id: string; scopes: string[] } };
    };
    expect(body.success).toBe(true);
    expect(body.data.token.startsWith('tmt_')).toBe(true);
    expect(body.data.record.scopes).toEqual(['read']);

    const listRes = await app.request('/');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { tokens: Array<Record<string, unknown>> };
    };
    expect(listBody.data.tokens).toHaveLength(1);
    expect(JSON.stringify(listBody.data.tokens)).not.toContain(body.data.token);
    expect('token' in listBody.data.tokens[0]).toBe(false);
  });

  it('revokes and renames through the route', async () => {
    const app = routeApp();
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'one', scopes: ['write'] }),
    });
    const body = (await created.json()) as { data: { record: { id: string } } };
    const id = body.data.record.id;

    const renamed = await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'two' }),
    });
    expect(renamed.status).toBe(200);

    const revoked = await app.request(`/${id}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);

    const again = await app.request(`/${id}/revoke`, { method: 'POST' });
    expect(again.status).toBe(404);
  });

  it('rejects an invalid create body with 400', async () => {
    const app = routeApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});
