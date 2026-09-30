import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

/**
 * Task 111 (Wave 13) end-to-end verification - verification-only lane, NO product code.
 *
 * Produces, from REAL runs, the four evidence artefacts into the workspace evidence dir
 * (`D:\Works\.omo\evidence`, override with WAVE13_111_EVIDENCE_DIR):
 *
 *   1. task-111-assistant-transcript.json - drives the REAL `/api/agent` routes the in-app
 *      assistant uses (`useAssistant.submit` -> POST /api/agent/actions/:tool, confirm via
 *      POST /api/agent/confirm/:id) through create -> query -> complete, plus the destructive
 *      confirmation round-trip (confirm_required -> executed -> 409 already_used).
 *   2. task-111-mcp-jsonrpc-log.json     - a JSON-RPC client against the REAL `/api/mcp` route:
 *      initialize -> tools/list -> tools/call -> resources/list -> resources/read, plus the
 *      documented -32002 / -32003 errors.
 *   3. task-111-patterns.json            - `recomputePatterns()` over a SEEDED 90-day history
 *      (event_trigger_logs / accounts / events / claims / habits / contacts), then the surfaced
 *      list `listPatterns()` would return (`GET /api/patterns` uses the same call).
 *   4. task-111-local-model-status.json  - the REAL `/api/ai/status` + `/api/ai/test` routes with
 *      `OLLAMA_BASE_URL` pointed at a mocked OpenAI-compatible endpoint served by an in-process
 *      HTTP server on 127.0.0.1 (real fetch, real wire bytes), plus the mid-pass disconnect QA.
 *
 * The harness is an in-process Hono app with a SQL-aware in-memory store (the mcp.test.ts /
 * agent-actions.test.ts pattern). No product file is imported differently from production; the
 * only substitution is `db.query` + the auth middleware session, exactly like the shipped suites.
 */

const authState = vi.hoisted(() => ({
  user: null as { id: number; username: string } | null,
}));
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: mockQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(
        c,
        next,
      );
    },
  };
});

import { hashAgentToken } from '../services/agent-tokens.service.js';
import { parseOperation, type ParserAi } from '../services/ai/parse.js';
import { createAiGateway, type AiStatus } from '../services/ai/gateway.js';
import { listPatterns, recomputePatterns } from '../services/patterns.service.js';
import agentRoutes from '../routes/agent.js';
import mcpRoutes from '../routes/mcp.js';
import aiRoutes from '../routes/ai.js';
import { csrfProtection } from '../middleware/csrf.js';

// -------------------------------------------------------------------------------------------
// Evidence dir
// -------------------------------------------------------------------------------------------

function evidenceDir(): string {
  const override = process.env.WAVE13_111_EVIDENCE_DIR;
  if (override && override.trim()) return override;
  // backend/src/test -> ../../../../ == the workspace root; evidence lives NEXT TO the repo.
  return fileURLToPath(new URL('../../../../.omo/evidence/', import.meta.url));
}

interface WrittenArtefact {
  name: string;
  path: string;
  bytes: number;
}

function writeArtefact(name: string, payload: unknown): WrittenArtefact {
  const dir = evidenceDir();
  mkdirSync(dir, { recursive: true });
  const path = `${dir}${dir.endsWith('\\') || dir.endsWith('/') ? '' : '/'}${name}`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(path, text, 'utf8');
  return { name, path, bytes: Buffer.byteLength(text, 'utf8') };
}

// -------------------------------------------------------------------------------------------
// In-memory SQL-aware store (mirrors the shipped SQL used by the exercised paths)
// -------------------------------------------------------------------------------------------

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
  lunar_date: null;
  reminder_config: Record<string, unknown>;
  notification_channels: unknown[];
  notification_account_ids: unknown[];
  relationship_mapping_id: null;
  person_name: string | null;
  birth_date: null;
  birth_date_lunar: null;
  reminder_recipient_name: null;
  reminder_recipient_email: null;
  recurring_config: null;
  next_occurrence: null;
  created_at: string;
}
interface PatternRow {
  id: number;
  user_id: number;
  kind: string;
  key: string;
  value: unknown;
  confidence: number;
  evidence_count: number;
  computed_at: string | null;
}
interface TriggerRow {
  trigger_date: string;
  status: string;
  channel_results: unknown;
  created_at: string;
}

interface StoreState {
  tokens: TokenRow[];
  audits: AuditRow[];
  confirmations: ConfirmationRow[];
  events: EventRow[];
  completions: Array<{ user_id: number; event_id: number; occurrence_date: string }>;
  patterns: PatternRow[];
  triggerLogs: TriggerRow[];
  accounts: Array<{ type: string; is_active: boolean; connection_status: string | null }>;
  claims: string[];
  habits: Array<{ id: number; schedule_days: unknown; created_at: string }>;
  habitLogs: Array<{ habit_id: number; logged_on: string }>;
  contacts: Array<{ id: number; name: string; cadence_days: number }>;
  interactions: Array<{ contact_id: number; occurred_at: string }>;
  timezone: string | null;
  rateLimits: Map<string, { count: number; windowStart: number }>;
  sqlLog: string[];
  sequences: { token: number; audit: number; confirm: number; pattern: number; event: number };
}

function emptyStore(): StoreState {
  return {
    tokens: [],
    audits: [],
    confirmations: [],
    events: [],
    completions: [],
    patterns: [],
    triggerLogs: [],
    accounts: [],
    claims: [],
    habits: [],
    habitLogs: [],
    contacts: [],
    interactions: [],
    timezone: 'Asia/Shanghai',
    rateLimits: new Map(),
    sqlLog: [],
    sequences: { token: 0, audit: 0, confirm: 0, pattern: 0, event: 500 },
  };
}

let store: StoreState = emptyStore();

function uuid(prefix: number): string {
  return `00000000-0000-4000-8000-${String(prefix).padStart(12, '0')}`;
}

function installStore(seed: Partial<StoreState> = {}): void {
  store = { ...emptyStore(), ...seed, sequences: { ...emptyStore().sequences, ...(seed.sequences ?? {}) } };
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (text: string, params: unknown[] = []) => fakeQuery(text, params));
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function fakeQuery(text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  const sql = normalizeSql(text);
  store.sqlLog.push(sql);

  // --- agent rate limiter -------------------------------------------------------------------
  if (sql.startsWith('INSERT INTO rate_limits')) {
    const [key, , windowSeconds] = params as [string, number, number];
    const now = Date.now();
    const existing = store.rateLimits.get(key);
    if (!existing || existing.windowStart + windowSeconds * 1000 <= now) {
      store.rateLimits.set(key, { count: 1, windowStart: now });
    } else {
      existing.count += 1;
    }
    const entry = store.rateLimits.get(key);
    return { rows: [{ count: entry?.count ?? 1, window_start: new Date(entry?.windowStart ?? now) }], rowCount: 1 };
  }

  // --- agent tokens -------------------------------------------------------------------------
  if (sql.startsWith('SELECT id, user_id, name, token_hash, scopes')) {
    const [hash] = params as [string];
    const row = store.tokens.find((token) => token.token_hash === hash);
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('SELECT id, user_id, scopes, revoked_at, expires_at')) {
    const [hash] = params as [string];
    const row = store.tokens.find((token) => token.token_hash === hash);
    return {
      rows: row ? [{ id: row.id, user_id: row.user_id, scopes: row.scopes, revoked_at: row.revoked_at, expires_at: row.expires_at }] : [],
      rowCount: row ? 1 : 0,
    };
  }
  if (sql.startsWith('UPDATE agent_tokens SET last_used_at')) {
    const [id] = params as [string];
    const row = store.tokens.find((token) => token.id === id);
    if (row) row.last_used_at = new Date().toISOString();
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // --- agent audit log ----------------------------------------------------------------------
  if (sql.startsWith('INSERT INTO agent_audit_logs')) {
    const [userId, tokenId, tool, argsRedacted, decision, result, errorCode, durationMs, requestId] =
      params as [number | null, string | null, string, string, string, string | null, string | null, number | null, string | null];
    const row: AuditRow = {
      id: String((store.sequences.audit += 1)),
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
    store.audits.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE agent_audit_logs SET result = $2')) {
    const [auditId, result, errorCode, durationMs] = params as [string, string, string | null, number | null];
    const row = store.audits.find((audit) => audit.id === auditId);
    if (row) {
      row.result = result;
      row.error_code = errorCode;
      row.duration_ms = durationMs;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('SELECT id FROM agent_audit_logs WHERE request_id')) {
    const [requestId] = params as [string];
    const matches = store.audits.filter((audit) => audit.request_id === requestId);
    const row = matches[matches.length - 1];
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }

  // --- confirmations ------------------------------------------------------------------------
  if (sql.startsWith('INSERT INTO agent_confirmations')) {
    const [userId, tokenId, tool, argsJson, ttlSec] = params as [number, string | null, string, string, number];
    const now = Date.now();
    const row: ConfirmationRow = {
      id: uuid((store.sequences.confirm += 1)),
      user_id: userId,
      token_id: tokenId,
      tool,
      args: JSON.parse(argsJson),
      status: 'pending',
      created_at: new Date(now),
      expires_at: new Date(now + ttlSec * 1000),
      consumed_at: null,
    };
    store.confirmations.push(row);
    return { rows: [{ id: row.id, expires_at: row.expires_at }], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE agent_confirmations SET status = 'consumed'")) {
    const [id, userId] = params as [string, number];
    const hasPendingGuard = sql.includes("status = 'pending'");
    const hasTtlGuard = sql.includes('expires_at > now()');
    const row = store.confirmations.find(
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
    const row = store.confirmations.find((c) => c.id === id && c.user_id === userId);
    if (!row) return { rows: [], rowCount: 0 };
    return { rows: [{ status: row.status, expired: row.expires_at.getTime() <= Date.now() }], rowCount: 1 };
  }

  // --- events (create / list / complete / delete) -------------------------------------------
  if (sql.startsWith('INSERT INTO events')) {
    const p = params as unknown[];
    const row: EventRow = {
      id: (store.sequences.event += 1),
      user_id: Number(p[0]),
      name: String(p[1]),
      type: String(p[2]),
      date: String(p[3]),
      calendar_type: String(p[4]),
      lunar_date: null,
      reminder_config: (p[6] as Record<string, unknown>) ?? {},
      notification_channels: [],
      notification_account_ids: [],
      relationship_mapping_id: null,
      person_name: p[10] == null ? null : String(p[10]),
      birth_date: null,
      birth_date_lunar: null,
      reminder_recipient_name: null,
      reminder_recipient_email: null,
      recurring_config: null,
      next_occurrence: null,
      created_at: new Date().toISOString(),
    };
    store.events.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT COUNT(*) as total FROM events WHERE user_id = $1')) {
    const [userId] = params as [number];
    const total = store.events.filter((event) => event.user_id === userId).length;
    return { rows: [{ total }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT * FROM events WHERE user_id = $1')) {
    const [userId, limit, offset] = params as [number, number, number];
    const rows = store.events
      .filter((event) => event.user_id === userId)
      .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1))
      .slice(offset ?? 0, (offset ?? 0) + (limit ?? 20))
      .map((event) => ({ ...event }));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith('SELECT id, date::text AS date FROM events WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as [number, number];
    const row = store.events.find((event) => event.id === id && event.user_id === userId);
    return { rows: row ? [{ id: row.id, date: row.date }] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('DELETE FROM events WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as [number | string, number | string];
    const before = store.events.length;
    // The handler passes `String(...)`; Postgres compares text to int via the column type, so the
    // fake compares on the string form of both sides (never a strict number-vs-string compare).
    store.events = store.events.filter(
      (event) => !(String(event.id) === String(id) && String(event.user_id) === String(userId)),
    );
    return { rows: [], rowCount: before - store.events.length };
  }
  if (sql.startsWith('INSERT INTO todo_completions')) {
    const [userId, eventId, occurrenceDate] = params as [number, number, string];
    const existing = store.completions.find(
      (row) => row.user_id === userId && row.event_id === eventId && row.occurrence_date === occurrenceDate,
    );
    if (!existing) store.completions.push({ user_id: userId, event_id: eventId, occurrence_date: occurrenceDate });
    return { rows: [], rowCount: 1 };
  }

  // --- pattern miner sources ------------------------------------------------------------------
  if (sql.startsWith('SELECT timezone FROM user_configs')) {
    return { rows: store.timezone === null ? [] : [{ timezone: store.timezone }], rowCount: store.timezone === null ? 0 : 1 };
  }
  if (sql.startsWith('SELECT trigger_date, status, channel_results, created_at FROM event_trigger_logs')) {
    return { rows: store.triggerLogs.map((row) => ({ ...row })), rowCount: store.triggerLogs.length };
  }
  if (sql.startsWith('SELECT type, is_active, connection_status FROM notification_accounts')) {
    return { rows: store.accounts.map((row) => ({ ...row })), rowCount: store.accounts.length };
  }
  if (sql.startsWith('SELECT event_type, date FROM events WHERE user_id = $1')) {
    const [userId] = params as [number];
    const rows = store.events.filter((event) => event.user_id === userId).map((event) => ({ event_type: event.type, date: event.date }));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('FROM reminder_send_claims')) {
    const rows = store.claims.map((trigger_date) => ({ trigger_date }));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith('SELECT id, schedule_days, created_at FROM habits')) {
    return { rows: store.habits.map((row) => ({ ...row })), rowCount: store.habits.length };
  }
  if (sql.startsWith('SELECT habit_id, logged_on FROM habit_logs')) {
    return { rows: store.habitLogs.map((row) => ({ ...row })), rowCount: store.habitLogs.length };
  }
  if (sql.startsWith('SELECT id, name, cadence_days FROM fixed_contacts')) {
    return { rows: store.contacts.map((row) => ({ ...row })), rowCount: store.contacts.length };
  }
  if (sql.startsWith('SELECT contact_id, occurred_at FROM interactions')) {
    return { rows: store.interactions.map((row) => ({ ...row })), rowCount: store.interactions.length };
  }

  // --- user_patterns --------------------------------------------------------------------------
  if (sql.startsWith('DELETE FROM user_patterns')) {
    const [userId] = params as [number];
    store.patterns = store.patterns.filter((pattern) => pattern.user_id !== userId);
    return { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('INSERT INTO user_patterns')) {
    const [userId, kind, key, valueJson, confidence, evidenceCount] = params as [number, string, string, string, number, number];
    const row: PatternRow = {
      id: (store.sequences.pattern += 1),
      user_id: userId,
      kind,
      key,
      value: JSON.parse(valueJson),
      confidence,
      evidence_count: evidenceCount,
      computed_at: new Date().toISOString(),
    };
    store.patterns.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id, user_id, kind, key, value, confidence, evidence_count, computed_at FROM user_patterns')) {
    const [userId, minConfidence, kind] = params as [number, number, string?];
    let rows = store.patterns.filter(
      (pattern) => pattern.user_id === userId && pattern.confidence >= minConfidence,
    );
    if (typeof kind === 'string') rows = rows.filter((pattern) => pattern.kind === kind);
    rows = rows
      .slice()
      .sort((a, b) =>
        a.kind === b.kind
          ? a.confidence === b.confidence
            ? (a.key < b.key ? -1 : 1)
            : b.confidence - a.confidence
          : a.kind < b.kind
            ? -1
            : 1,
      );
    return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
  }

  throw new Error(`wave13-111 fake db: unexpected SQL: ${sql}`);
}

// -------------------------------------------------------------------------------------------
// App builders
// -------------------------------------------------------------------------------------------

function buildApp(): Hono<{ Variables: { user: { id: number; username: string } } }> {
  const app = new Hono<{ Variables: { user: { id: number; username: string } } }>();
  app.use('*', csrfProtection());
  app.route('/api/agent', agentRoutes);
  app.route('/api/mcp', mcpRoutes);
  app.route('/api/ai', aiRoutes);
  return app;
}

const SESSION_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer wave13-111-session',
  'X-Requested-With': 'XMLHttpRequest',
};

function seedToken(input: { raw: string; scopes: string[]; userId?: number; revoked?: boolean }): TokenRow {
  const row: TokenRow = {
    id: uuid((store.sequences.token += 1)),
    user_id: input.userId ?? 1,
    name: 'wave13-111-seed',
    token_hash: hashAgentToken(input.raw),
    scopes: input.scopes,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: input.revoked ? new Date().toISOString() : null,
    expires_at: null,
  };
  store.tokens.push(row);
  return row;
}

function rawToken(seed: string): string {
  return `tmt_${seed.repeat(64).slice(0, 64)}`;
}

interface JsonResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

async function requestJson(
  app: Hono<{ Variables: { user: { id: number; username: string } } }>,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<JsonResponse> {
  const res = await app.request(path, {
    method: init.method,
    headers: init.headers ?? SESSION_HEADERS,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

// -------------------------------------------------------------------------------------------
// Runner 1: assistant transcript (create -> query -> complete + destructive confirm round-trip)
// -------------------------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-09-30T12:00:00.000Z');

interface TranscriptTurn {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  tool?: string;
  args?: unknown;
  status?: string;
  httpStatus?: number;
  response?: unknown;
  request?: { method: string; path: string; body?: unknown };
}

interface AssistantTranscriptArtefact {
  schemaVersion: 1;
  kind: 'assistant-transcript';
  generatedAt: string;
  generatedBy: string;
  aiEnabled: false;
  note: string;
  turns: TranscriptTurn[];
  destructive: {
    deleteRequestsBeforeConfirm: number;
    deleteStatementsBeforeConfirm: number;
    deleteStatementsAfterConfirm: number;
    secondConfirmHttpStatus: number;
    secondConfirmError: unknown;
  };
  draftPreservation: {
    degradedUtterance: string;
    providerUp: unknown;
    providerDown: unknown;
    inputPreserved: boolean;
    sourceGuards: Array<{ file: string; check: string; detail: string }>;
  };
}

async function runAssistantTranscript(): Promise<AssistantTranscriptArtefact> {
  installStore({ timezone: 'Asia/Shanghai' });
  authState.user = { id: 1, username: 'wave13-111' };
  const app = buildApp();
  const turns: TranscriptTurn[] = [];
  let seq = 0;
  const push = (turn: Omit<TranscriptTurn, 'seq'>) => {
    seq += 1;
    turns.push({ seq, ...turn });
  };

  // Turn 1: the assistant's registry view (useAssistant.loadTools -> GET /api/agent/tools).
  const tools = await requestJson(app, '/api/agent/tools', { method: 'GET' });
  const toolNames = ((tools.body as { data?: { tools?: Array<{ name: string }> } }).data?.tools ?? []).map((t) => t.name);
  push({
    role: 'user',
    text: '打开助手，看看能做什么',
    request: { method: 'GET', path: '/api/agent/tools' },
    status: tools.status === 200 ? 'executed' : 'failed',
    httpStatus: tools.status,
    response: { toolCount: toolNames.length, hasCreateEvent: toolNames.includes('create_event') },
  });

  // Turn 2: create (submit -> POST /api/agent/actions/create_event).
  const CREATE_ARGS = { name: '给妈妈打电话', date: '2026-10-01' };
  const created = await requestJson(app, '/api/agent/actions/create_event', {
    method: 'POST',
    body: { args: CREATE_ARGS },
  });
  const createdData = (created.body as { data?: { id?: number } }).data;
  const createdId = createdData?.id;
  push({
    role: 'user',
    text: '明天提醒我给妈妈打电话',
    request: { method: 'POST', path: '/api/agent/actions/create_event', body: { args: CREATE_ARGS } },
  });
  push({
    role: 'assistant',
    text: created.status === 200 ? '已执行。' : '执行失败。',
    tool: 'create_event',
    args: CREATE_ARGS,
    status: created.status === 200 ? 'executed' : 'failed',
    httpStatus: created.status,
    response: created.body,
  });

  // Turn 3: query (list_events).
  const listArgs = { limit: 20 };
  const listed = await requestJson(app, '/api/agent/actions/list_events', { method: 'POST', body: { args: listArgs } });
  const listedEvents = ((listed.body as { data?: { events?: Array<{ id: number }> } }).data?.events ?? []);
  push({
    role: 'user',
    text: '看看我最近的事件',
    request: { method: 'POST', path: '/api/agent/actions/list_events', body: { args: listArgs } },
  });
  push({
    role: 'assistant',
    text: listed.status === 200 ? '已执行。' : '执行失败。',
    tool: 'list_events',
    args: listArgs,
    status: listed.status === 200 ? 'executed' : 'failed',
    httpStatus: listed.status,
    response: { count: listedEvents.length, ids: listedEvents.map((e) => e.id) },
  });

  // Turn 4: complete (complete_todo).
  const completeArgs = { eventId: createdId };
  const completed = await requestJson(app, '/api/agent/actions/complete_todo', { method: 'POST', body: { args: completeArgs } });
  push({
    role: 'user',
    text: '这件事完成了',
    request: { method: 'POST', path: '/api/agent/actions/complete_todo', body: { args: completeArgs } },
  });
  push({
    role: 'assistant',
    text: completed.status === 200 ? '已执行。' : '执行失败。',
    tool: 'complete_todo',
    args: completeArgs,
    status: completed.status === 200 ? 'executed' : 'failed',
    httpStatus: completed.status,
    response: completed.body,
  });

  // Turn 5: destructive -> confirmation required (nothing executes).
  const deleteArgs = { eventId: createdId };
  const deleteStatementsBeforeConfirm = store.sqlLog.filter((sql) => sql.startsWith('DELETE FROM events')).length;
  const deleteRequest = await requestJson(app, '/api/agent/actions/delete_event', {
    method: 'POST',
    body: { args: deleteArgs },
  });
  const confirmData = (deleteRequest.body as { data?: { status?: string; confirmationId?: string; preview?: unknown } }).data;
  push({
    role: 'user',
    text: `删除事件 ${String(createdId)}`,
    request: { method: 'POST', path: '/api/agent/actions/delete_event', body: { args: deleteArgs } },
  });
  push({
    role: 'assistant',
    text: '工具 delete_event 需要你确认后才会执行。',
    tool: 'delete_event',
    args: deleteArgs,
    status: confirmData?.status === 'confirm_required' ? 'confirm_required' : 'failed',
    httpStatus: deleteRequest.status,
    response: deleteRequest.body,
  });

  // Turn 6: the ONLY place a confirm request is sent (useAssistant.confirm).
  const confirmationId = confirmData?.confirmationId ?? '';
  const confirmed = await requestJson(app, `/api/agent/confirm/${confirmationId}`, { method: 'POST' });
  push({
    role: 'user',
    text: '确认',
    request: { method: 'POST', path: '/api/agent/confirm/:id' },
  });
  push({
    role: 'assistant',
    text: confirmed.status === 200 ? '已确认并执行。' : '确认失败。',
    tool: 'delete_event',
    status: confirmed.status === 200 ? 'executed' : 'failed',
    httpStatus: confirmed.status,
    response: confirmed.body,
  });

  // Replay: the same confirmation is single-use in the data layer -> 409.
  const replayed = await requestJson(app, `/api/agent/confirm/${confirmationId}`, { method: 'POST' });

  const deleteStatementsAfterConfirm = store.sqlLog.filter((sql) => sql.startsWith('DELETE FROM events')).length;

  // --- QA case: mid-pass provider disconnect -> deterministic path, draft preserved ----------
  const degrade = await runDegradeCase();
  const sourceGuards = readDraftSourceGuards();
  push({
    role: 'user',
    text: degrade.utterance,
    request: { method: 'POST', path: '(ai parse service: parseOperation)' },
  });
  push({
    role: 'assistant',
    text: degrade.providerDown.layer === 'regex' ? '已降级到确定性解析路径。' : '未降级。',
    tool: degrade.providerDown.operation?.kind ?? 'unknown',
    args: { title: degrade.providerDown.operation?.title ?? null, date: degrade.providerDown.operation?.date ?? null },
    status: degrade.inputPreserved ? 'executed' : 'failed',
    response: { layer: degrade.providerDown.layer, operation: degrade.providerDown.operation },
  });

  const artefact: AssistantTranscriptArtefact = {
    schemaVersion: 1,
    kind: 'assistant-transcript',
    generatedAt: new Date().toISOString(),
    generatedBy: 'backend/src/test/wave13-111-verification.test.ts',
    aiEnabled: false,
    note:
      'The in-app assistant (frontend AssistantPanel/useAssistant) resolves intent client-side and calls ' +
      'POST /api/agent/actions/:tool; the confirm request is sent only from useAssistant.confirm. The AI ' +
      'path of the assistant journey is parseOperation (checkbox 99): with the provider disconnected ' +
      'mid-pass it degrades primary -> json_schema -> regex (deterministic parseWithRegex) and the draft ' +
      'text is preserved.',
    turns,
    destructive: {
      deleteRequestsBeforeConfirm: deleteStatementsBeforeConfirm,
      deleteStatementsBeforeConfirm,
      deleteStatementsAfterConfirm,
      secondConfirmHttpStatus: replayed.status,
      secondConfirmError: replayed.body,
    },
    draftPreservation: {
      degradedUtterance: degrade.utterance,
      providerUp: degrade.providerUp,
      providerDown: degrade.providerDown,
      inputPreserved: degrade.inputPreserved,
      sourceGuards,
    },
  };
  return artefact;
}

// -------------------------------------------------------------------------------------------
// Provider-mock + degrade helpers
// -------------------------------------------------------------------------------------------

const OLLAMA_MODEL = 'timemark-mock:1b';

interface MockProvider {
  server: Server;
  baseUrl: string;
  port: number;
  chatRequests: Array<Record<string, unknown>>;
}

/** OpenAI-compatible mock endpoint (Ollama/LM Studio shape) served over real HTTP on 127.0.0.1. */
async function startMockProvider(op?: { title: string; date: string }): Promise<MockProvider> {
  const operation = {
    kind: 'create_event',
    title: op?.title ?? '买菜',
    date: op?.date ?? '2026-10-01',
    confidence: 0.95,
  };
  const chatRequests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.endsWith('/models')) {
        send(200, { object: 'list', data: [{ id: OLLAMA_MODEL, object: 'model' }] });
        return;
      }
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        chatRequests.push({
          model: parsed.model,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
          usedTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
        });
        const wantsTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        const message = wantsTools
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'record_operation', arguments: JSON.stringify(operation) } },
              ],
            }
          : { role: 'assistant', content: JSON.stringify(operation) };
        send(200, {
          id: 'cmpl-wave13-111',
          object: 'chat.completion',
          model: OLLAMA_MODEL,
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: { prompt_tokens: 41, completion_tokens: 17, total_tokens: 58 },
        });
        return;
      }
      send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, port, chatRequests };
}

async function stopMockProvider(provider: MockProvider): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    provider.server.close((error) => (error ? reject(error) : resolve()));
  });
}

interface DegradeOperationView {
  kind: string;
  title?: string | null;
  date?: string | null;
}
interface DegradeSide {
  layer: string;
  operation: DegradeOperationView | null;
}
interface DegradeOutcome {
  utterance: string;
  providerUp: DegradeSide;
  providerDown: DegradeSide;
  inputPreserved: boolean;
}

/** Provider up -> layer primary; disconnect; the SAME pass hits primary+fallback+regex. */
async function runDegradeCase(): Promise<DegradeOutcome> {
  const provider = await startMockProvider({ title: '买菜', date: '2026-10-01' });
  const env = { OLLAMA_BASE_URL: provider.baseUrl, OLLAMA_MODEL };
  const gateway = createAiGateway({ env, random: () => 0 });
  const ai: ParserAi = { chat: (messages, options) => gateway.chat(messages, options) };
  const utterance = '明天买菜';

  const passA = await parseOperation(utterance, { ai, now: FIXED_NOW, timezone: 'Asia/Shanghai' });
  const upA = passA.status === 'ok' ? passA.operation : null;

  // Mid-pass disconnect: the provider dies before the json_schema fallback can answer.
  await stopMockProvider(provider);

  const passB = await parseOperation(utterance, { ai, now: FIXED_NOW, timezone: 'Asia/Shanghai' });
  const downB = passB.status === 'ok' ? passB.operation : null;

  const inputPreserved =
    upA !== null &&
    downB !== null &&
    passA.status === 'ok' &&
    passB.status === 'ok' &&
    passA.layer === 'primary' &&
    passB.layer === 'regex' &&
    downB.kind === 'create_event' &&
    upA.kind === 'create_event' &&
    downB.title === upA.title &&
    downB.date === upA.date;

  return {
    utterance,
    providerUp: { layer: passA.layer, operation: upA },
    providerDown: { layer: passB.layer, operation: downB },
    inputPreserved,
  };
}

/** Read-only source guards: the frontend captures the draft into the transcript before any failure. */
function readDraftSourceGuards(): Array<{ file: string; check: string; detail: string }> {
  const hookPath = fileURLToPath(new URL('../../../frontend/src/hooks/useAssistant.ts', import.meta.url));
  const panelPath = fileURLToPath(new URL('../../../frontend/src/components/assistant/AssistantPanel.tsx', import.meta.url));
  const hook = readFileSync(hookPath, 'utf8');
  const panel = readFileSync(panelPath, 'utf8');

  const userAppend = hook.indexOf("role: 'user', text }]");
  const intentResolve = hook.indexOf('resolveAssistantIntent(text');
  const failedPatch = hook.indexOf("status: 'failed'");
  const panelText = panel.indexOf('const text = draft.trim()');
  const panelClear = panel.indexOf("setDraft('')");

  const guards = [
    {
      file: 'frontend/src/hooks/useAssistant.ts',
      check: 'user-append-before-intent-resolution',
      detail: `userAppend=${userAppend} < resolveAssistantIntent=${intentResolve}`,
    },
    {
      file: 'frontend/src/hooks/useAssistant.ts',
      check: 'failure-patches-transcript-does-not-clear-messages',
      detail: `failedPatch=${failedPatch} (runTool catch keeps the user message and records the failure)`,
    },
    {
      file: 'frontend/src/components/assistant/AssistantPanel.tsx',
      check: 'capture-draft-before-clear',
      detail: `text=${panelText} < setDraft('')=${panelClear}`,
    },
  ];
  if (!(userAppend >= 0 && intentResolve >= 0 && userAppend < intentResolve)) {
    throw new Error('draft guard failed: user message is not appended before intent resolution');
  }
  if (!(failedPatch >= 0)) throw new Error('draft guard failed: no failure patch found in useAssistant');
  if (!(panelText >= 0 && panelClear >= 0 && panelText < panelClear)) {
    throw new Error('draft guard failed: the panel clears the draft before capturing it');
  }
  return guards;
}

// -------------------------------------------------------------------------------------------
// Runner 2: MCP JSON-RPC log
// -------------------------------------------------------------------------------------------

interface McpExchange {
  id: number | string;
  method: string;
  request: unknown;
  httpStatus: number;
  response: unknown;
}

interface McpLogArtefact {
  schemaVersion: 1;
  kind: 'mcp-jsonrpc-log';
  generatedAt: string;
  transport: string;
  protocolVersion: string | null;
  serverName: string | null;
  exchanges: McpExchange[];
  auditRows: number;
}

async function runMcpLog(): Promise<McpLogArtefact> {
  installStore({ timezone: 'Asia/Shanghai' });
  process.env.MCP_ENABLED = 'true';
  authState.user = { id: 1, username: 'wave13-111' };
  const adminRaw = rawToken('a');
  seedToken({ raw: adminRaw, scopes: ['admin'] });
  const readRaw = rawToken('r');
  seedToken({ raw: readRaw, scopes: ['read'] });

  store.events.push({
    id: 501,
    user_id: 1,
    name: '生日聚会',
    type: 'birthday',
    date: '2026-10-05',
    calendar_type: 'gregorian',
    lunar_date: null,
    reminder_config: { enabled: true, daysBeforeList: [1, 3, 7], emailRecipients: [] },
    notification_channels: [],
    notification_account_ids: [],
    relationship_mapping_id: null,
    person_name: null,
    birth_date: null,
    birth_date_lunar: null,
    reminder_recipient_name: null,
    reminder_recipient_email: null,
    recurring_config: null,
    next_occurrence: null,
    created_at: new Date().toISOString(),
  });
  store.patterns.push(
    { id: 1, user_id: 1, kind: 'reminder_time', key: '09:00', value: { hour: '09:00', total: 90 }, confidence: 0.9, evidence_count: 90, computed_at: new Date().toISOString() },
    { id: 2, user_id: 1, kind: 'channel', key: 'email', value: { channel: 'email', success: 90 }, confidence: 0.9, evidence_count: 90, computed_at: new Date().toISOString() },
    { id: 3, user_id: 1, kind: 'reminder_time', key: '21:00', value: { hour: '21:00', total: 12 }, confidence: 0.3, evidence_count: 1, computed_at: new Date().toISOString() },
  );

  const app = buildApp();
  const exchanges: McpExchange[] = [];
  let protocolVersion: string | null = null;
  let serverName: string | null = null;

  const call = async (id: number, method: string, params: unknown, token: string): Promise<McpExchange> => {
    const request = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    let response: unknown = text;
    try {
      response = text ? JSON.parse(text) : null;
    } catch {
      response = text;
    }
    const exchange: McpExchange = { id, method, request, httpStatus: res.status, response };
    exchanges.push(exchange);
    return exchange;
  };

  // notifications/initialized (JSON-RPC notification; no response body expected).
  await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminRaw}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const init = await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wave13-111-client', version: '1.0.0' } }, adminRaw);
  const initResult = (init.response as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } }).result;
  protocolVersion = initResult?.protocolVersion ?? null;
  serverName = initResult?.serverInfo?.name ?? null;

  await call(2, 'tools/list', {}, adminRaw);
  await call(3, 'tools/call', { name: 'list_events', arguments: { limit: 20 } }, adminRaw);
  await call(4, 'resources/list', {}, adminRaw);
  await call(5, 'resources/read', { uri: 'timemark://patterns' }, adminRaw);
  await call(6, 'resources/read', { uri: 'timemark://does-not-exist' }, adminRaw);
  await call(7, 'tools/call', { name: 'delete_event', arguments: { eventId: 501 } }, readRaw);

  return {
    schemaVersion: 1,
    kind: 'mcp-jsonrpc-log',
    generatedAt: new Date().toISOString(),
    transport: 'in-process Hono app.request() against POST /api/mcp (Streamable HTTP, JSON-RPC 2.0)',
    protocolVersion,
    serverName,
    exchanges,
    auditRows: store.audits.length,
  };
}

// -------------------------------------------------------------------------------------------
// Runner 3: pattern miner over a seeded 90-day history
// -------------------------------------------------------------------------------------------

interface PatternsArtefact {
  schemaVersion: 1;
  kind: 'patterns';
  generatedAt: string;
  seed: { days: number; triggerLogs: number; claims: number; habits: number; contacts: number; timezone: string };
  computed: unknown[];
  surfaced: unknown[];
  kindsPresent: string[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function shiftYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

async function runPatternMiner(): Promise<PatternsArtefact> {
  installStore({ timezone: 'Asia/Shanghai' });
  const today = '2026-09-30';
  const triggerLogs: TriggerRow[] = [];
  const claims: string[] = [];
  for (let offset = 89; offset >= 0; offset -= 1) {
    const ymd = shiftYmd(today, -offset);
    // Morning 09:00 (+08) reminder, delivered every day: 90 consistent observations.
    triggerLogs.push({
      trigger_date: `${ymd}#d0#t09:00`,
      status: 'success',
      channel_results: { email: { success: true }, telegram: { success: true } },
      created_at: `${ymd}T01:00:00Z`,
    });
    // The d1 lead, delivered on 60 of the 90 days.
    if (offset < 60) {
      triggerLogs.push({
        trigger_date: `${ymd}#d1#t09:00`,
        status: 'success',
        channel_results: { email: { success: true } },
        created_at: `${ymd}T01:00:00Z`,
      });
    }
    // The d7 lead: 15 delivered, 5 failed (20 observations -> confidence 0.9, keep_rate 0.75).
    if (offset < 20) {
      const success = offset >= 5;
      triggerLogs.push({
        trigger_date: `${ymd}#d7#t09:00`,
        status: success ? 'success' : 'failed',
        channel_results: { email: { success } },
        created_at: `${ymd}T01:00:00Z`,
      });
    }
    // Evening 21:00 bucket: 12 attempts, only 1 delivered -> stored below the 0.5 surface line.
    // A distinct `#d3` lead keeps the d0 lead count exactly the 90 daily deliveries.
    if (offset < 12) {
      const success = offset === 0;
      triggerLogs.push({
        trigger_date: `${ymd}#d3#t21:00`,
        status: success ? 'success' : 'failed',
        channel_results: { slack: { success } },
        created_at: `${ymd}T13:00:00Z`,
      });
    }
    if (offset < 30) claims.push(`${ymd}#d0#t09:00`);
  }
  for (let index = 0; index < 10; index += 1) {
    claims.push(`snooze:event#${500 + index}#2026-09-${pad2(10 + index)}T00:00:00.000Z`);
  }

  const events: EventRow[] = [];
  for (let offset = 89; offset >= 0; offset -= 1) {
    const ymd = shiftYmd(today, -offset);
    const type = offset % 3 === 0 ? 'birthday' : offset % 3 === 1 ? 'meeting' : 'other';
    events.push({
      id: 1 + (89 - offset),
      user_id: 1,
      name: `${type}-${ymd}`,
      type,
      date: ymd,
      calendar_type: 'gregorian',
      lunar_date: null,
      reminder_config: {},
      notification_channels: [],
      notification_account_ids: [],
      relationship_mapping_id: null,
      person_name: null,
      birth_date: null,
      birth_date_lunar: null,
      reminder_recipient_name: null,
      reminder_recipient_email: null,
      recurring_config: null,
      next_occurrence: null,
      created_at: `${ymd}T00:00:00Z`,
    });
  }

  const habitLogs: Array<{ habit_id: number; logged_on: string }> = [];
  for (let offset = 89; offset >= 0; offset -= 1) {
    if (offset % 9 === 0) continue; // ~70 completions of 90 scheduled days
    habitLogs.push({ habit_id: 7, logged_on: shiftYmd(today, -offset) });
  }

  installStore({
    timezone: 'Asia/Shanghai',
    triggerLogs,
    claims,
    accounts: [
      { type: 'email', is_active: true, connection_status: 'healthy' },
      { type: 'telegram', is_active: false, connection_status: null },
    ],
    events,
    habits: [{ id: 7, schedule_days: [], created_at: '2026-06-01T00:00:00.000Z' }],
    habitLogs,
    contacts: [{ id: 9, name: '张三', cadence_days: 30 }],
    interactions: [
      { contact_id: 9, occurred_at: '2026-05-01T00:00:00Z' },
      { contact_id: 9, occurred_at: '2026-06-10T00:00:00Z' },
      { contact_id: 9, occurred_at: '2026-07-20T00:00:00Z' },
      { contact_id: 9, occurred_at: '2026-08-30T00:00:00Z' },
      { contact_id: 9, occurred_at: '2026-09-25T00:00:00Z' },
    ],
  });

  const computed = await recomputePatterns(1, FIXED_NOW);
  const surfaced = await listPatterns(1);

  return {
    schemaVersion: 1,
    kind: 'patterns',
    generatedAt: new Date().toISOString(),
    seed: {
      days: 90,
      triggerLogs: triggerLogs.length,
      claims: claims.length,
      habits: 1,
      contacts: 1,
      timezone: 'Asia/Shanghai',
    },
    computed: computed as unknown[],
    surfaced: surfaced as unknown[],
    kindsPresent: [...new Set(computed.map((pattern) => pattern.kind))].sort(),
  };
}

// -------------------------------------------------------------------------------------------
// Runner 4: local-model status via /api/ai/status against a mocked endpoint
// -------------------------------------------------------------------------------------------

interface LocalModelArtefact {
  schemaVersion: 1;
  kind: 'local-model-status';
  generatedAt: string;
  endpoint: string;
  model: string;
  status: AiStatus;
  statusWithProbeConnected: AiStatus;
  testConnection: unknown;
  chat: unknown;
  afterDisconnect: { status: AiStatus; chatErrorCode: string | null };
  aiDisabled: { enabled: boolean; chatErrorCode: string | null; parseLayer: string | null };
  chatRequests: Array<Record<string, unknown>>;
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
  }
}

async function runLocalModel(): Promise<LocalModelArtefact> {
  const provider = await startMockProvider({ title: '买菜', date: '2026-10-01' });
  authState.user = { id: 1, username: 'wave13-111' };
  const app = buildApp();

  const saved = {
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_FALLBACK_BASE_URL: process.env.AI_FALLBACK_BASE_URL,
    AI_FALLBACK_API_KEY: process.env.AI_FALLBACK_API_KEY,
    AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL,
  };
  process.env.OLLAMA_BASE_URL = provider.baseUrl;
  process.env.OLLAMA_MODEL = OLLAMA_MODEL;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.AI_FALLBACK_BASE_URL;
  delete process.env.AI_FALLBACK_API_KEY;
  delete process.env.AI_FALLBACK_MODEL;

  try {
    const statusBefore = await requestJson(app, '/api/ai/status', { method: 'GET' });
    const statusProbe = await requestJson(app, '/api/ai/status', { method: 'GET' });
    const test = await requestJson(app, '/api/ai/test', { method: 'POST', body: { provider: 'local' } });

    const env = { OLLAMA_BASE_URL: provider.baseUrl, OLLAMA_MODEL };
    const gateway = createAiGateway({ env, random: () => 0 });
    const chatResult = await gateway.chat([{ role: 'user', content: 'ping' }], {
      jsonSchema: { name: 'wave13_111', strict: true, schema: { type: 'object' } },
      useCache: false,
    });

    // Mid-pass disconnect on the shared provider.
    await stopMockProvider(provider);

    const statusAfter = await requestJson(app, '/api/ai/status', { method: 'GET' });
    const chatErrorCode = await errorCodeOf(gateway.chat([{ role: 'user', content: 'ping' }], { useCache: false }));

    const disabled = createAiGateway({ env: {}, random: () => 0 });
    const disabledStatus = disabled.status();
    const disabledErrorCode = await errorCodeOf(disabled.chat([{ role: 'user', content: 'ping' }]));
    const disabledParse = await parseOperation('明天买菜', {
      ai: { chat: (messages, options) => disabled.chat(messages, options) },
      now: FIXED_NOW,
      timezone: 'Asia/Shanghai',
    });

    return {
      schemaVersion: 1,
      kind: 'local-model-status',
      generatedAt: new Date().toISOString(),
      endpoint: provider.baseUrl,
      model: OLLAMA_MODEL,
      status: (statusBefore.body as { data: AiStatus }).data,
      statusWithProbeConnected: (statusProbe.body as { data: AiStatus }).data,
      testConnection: test.body,
      chat: chatResult,
      afterDisconnect: {
        status: (statusAfter.body as { data: AiStatus }).data,
        chatErrorCode,
      },
      aiDisabled: {
        enabled: disabledStatus.enabled,
        chatErrorCode: disabledErrorCode,
        parseLayer: disabledParse.layer,
      },
      chatRequests: provider.chatRequests,
    };
  } finally {
    if (saved.OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved.OLLAMA_BASE_URL;
    if (saved.OLLAMA_MODEL === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = saved.OLLAMA_MODEL;
    if (saved.OLLAMA_API_KEY === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = saved.OLLAMA_API_KEY;
    if (saved.AI_BASE_URL === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = saved.AI_BASE_URL;
    if (saved.AI_API_KEY === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = saved.AI_API_KEY;
    if (saved.AI_MODEL === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = saved.AI_MODEL;
    if (saved.AI_FALLBACK_BASE_URL === undefined) delete process.env.AI_FALLBACK_BASE_URL;
    else process.env.AI_FALLBACK_BASE_URL = saved.AI_FALLBACK_BASE_URL;
    if (saved.AI_FALLBACK_API_KEY === undefined) delete process.env.AI_FALLBACK_API_KEY;
    else process.env.AI_FALLBACK_API_KEY = saved.AI_FALLBACK_API_KEY;
    if (saved.AI_FALLBACK_MODEL === undefined) delete process.env.AI_FALLBACK_MODEL;
    else process.env.AI_FALLBACK_MODEL = saved.AI_FALLBACK_MODEL;
  }
}

// -------------------------------------------------------------------------------------------
// The single generation pass (beforeAll) + tests
// -------------------------------------------------------------------------------------------

interface GeneratedBundle {
  transcript: AssistantTranscriptArtefact;
  mcp: McpLogArtefact;
  patterns: PatternsArtefact;
  localModel: LocalModelArtefact;
  written: WrittenArtefact[];
}

let bundle: GeneratedBundle;

beforeEach(() => {
  authState.user = { id: 1, username: 'wave13-111' };
  process.env.MCP_ENABLED = 'true';
});

describe('task 111 - Wave 13 end-to-end verification (generates the four artefacts)', () => {
  beforeAll(async () => {
    const transcript = await runAssistantTranscript();
    const mcp = await runMcpLog();
    const patterns = await runPatternMiner();
    const localModel = await runLocalModel();
    const written = [
      writeArtefact('task-111-assistant-transcript.json', transcript),
      writeArtefact('task-111-mcp-jsonrpc-log.json', mcp),
      writeArtefact('task-111-patterns.json', patterns),
      writeArtefact('task-111-local-model-status.json', localModel),
    ];
    bundle = { transcript, mcp, patterns, localModel, written };
  }, 60_000);

  it('assistant: create -> query -> complete executes through the real /api/agent routes', () => {
    const toolTurn = (tool: string) => bundle.transcript.turns.find((turn) => turn.tool === tool && turn.status !== undefined);
    expect(toolTurn('create_event')?.status).toBe('executed');
    expect(toolTurn('create_event')?.httpStatus).toBe(200);
    expect(toolTurn('list_events')?.status).toBe('executed');
    expect(toolTurn('complete_todo')?.status).toBe('executed');
    const createdId = (bundle.transcript.turns.find((turn) => turn.tool === 'create_event')?.args as { name?: string } | undefined)?.name;
    expect(createdId).toBe('给妈妈打电话');
    // The query result really contains the created event.
    const queryTurn = bundle.transcript.turns.find((turn) => turn.tool === 'list_events');
    const queryResponse = queryTurn?.response as { count?: number } | undefined;
    expect(queryResponse?.count).toBeGreaterThanOrEqual(1);
  });

  it('assistant: the destructive tool is never auto-executed; confirm is single-use', () => {
    expect(bundle.transcript.destructive.deleteStatementsBeforeConfirm).toBe(0);
    expect(bundle.transcript.destructive.deleteStatementsAfterConfirm).toBe(1);
    expect(bundle.transcript.destructive.secondConfirmHttpStatus).toBe(409);
    const confirmTurn = bundle.transcript.turns.find((turn) => turn.tool === 'delete_event' && turn.status === 'executed');
    expect(confirmTurn?.httpStatus).toBe(200);
    const requiredTurn = bundle.transcript.turns.find((turn) => turn.status === 'confirm_required');
    expect(requiredTurn).toBeDefined();
  });

  it('MCP: initialize -> tools/list -> tools/call -> resources/list -> resources/read all answered', () => {
    const methods = bundle.mcp.exchanges.map((exchange) => exchange.method);
    expect(methods).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/read',
      'resources/read',
      'tools/call',
    ]);
    expect(bundle.mcp.protocolVersion).toBe('2025-03-26');
    expect(bundle.mcp.serverName).toBe('timemark');

    const init = bundle.mcp.exchanges[0];
    expect(init.httpStatus).toBe(200);
    const listedTools = bundle.mcp.exchanges[1].response as { result?: { tools?: Array<{ name: string }> } };
    expect((listedTools.result?.tools ?? []).map((tool) => tool.name)).toContain('delete_event');

    const call = bundle.mcp.exchanges[2];
    expect(call.httpStatus).toBe(200);
    const callResult = call.response as { result?: { structuredContent?: { status?: string } } };
    expect(callResult.result?.structuredContent?.status).toBe('executed');

    const resources = bundle.mcp.exchanges[3].response as { result?: { resources?: Array<{ uri: string }> } };
    expect((resources.result?.resources ?? []).map((resource) => resource.uri)).toContain('timemark://patterns');

    const read = bundle.mcp.exchanges[4].response as { result?: { contents?: Array<{ uri: string; text: string }> } };
    expect(read.result?.contents?.[0]?.uri).toBe('timemark://patterns');
    const payload = JSON.parse(read.result?.contents?.[0]?.text ?? '{}') as { patterns?: unknown[] };
    expect(Array.isArray(payload.patterns)).toBe(true);

    const missing = bundle.mcp.exchanges[5].response as { error?: { code?: number; message?: string } };
    expect(missing.error?.code).toBe(-32002);
    expect(missing.error?.message).toBe('resource_not_found');

    const denied = bundle.mcp.exchanges[6].response as { error?: { code?: number; message?: string } };
    expect(denied.error?.code).toBe(-32003);
    // tools/call writes exactly one audit row per dispatch: one `allowed` (list_events) and one
    // `denied` scope_denied (delete_event with the read-only token).
    expect(bundle.mcp.auditRows).toBeGreaterThanOrEqual(2);
  });

  it('patterns: a seeded 90-day history surfaces every kind with sane evidence', () => {
    expect(bundle.patterns.seed.days).toBe(90);
    expect(bundle.patterns.seed.triggerLogs).toBeGreaterThan(150);
    expect(bundle.patterns.kindsPresent).toEqual(
      expect.arrayContaining(['reminder_time', 'lead_time', 'channel', 'weekday_type', 'snooze_frequency', 'habit_weekday', 'contact_cadence']),
    );
    const computed = bundle.patterns.computed as Array<{ kind: string; key: string; confidence: number; evidence_count: number; value: Record<string, unknown> }>;
    // reminder_time buckets by HOUR only, so the 09:00 bucket aggregates every lead day
    // (d0 90 + d1 60 + d7 15 = 165 delivered); the d0 lead carries exactly the 90 daily ones.
    const morning = computed.find((pattern) => pattern.kind === 'reminder_time' && pattern.key === '09:00');
    expect(morning?.evidence_count).toBeGreaterThanOrEqual(90);
    expect(morning?.confidence).toBeGreaterThanOrEqual(0.9);
    const d0 = computed.find((pattern) => pattern.kind === 'lead_time' && pattern.key === 'd0');
    expect(d0?.evidence_count).toBe(90);
    const evening = computed.find((pattern) => pattern.kind === 'reminder_time' && pattern.key === '21:00');
    expect(evening?.confidence).toBeLessThan(0.5);
    const surfaced = bundle.patterns.surfaced as Array<{ kind: string; key: string; confidence: number }>;
    expect(surfaced.some((pattern) => pattern.kind === 'reminder_time' && pattern.key === '09:00')).toBe(true);
    expect(surfaced.some((pattern) => pattern.kind === 'reminder_time' && pattern.key === '21:00')).toBe(false);
    const channel = computed.find((pattern) => pattern.kind === 'channel' && pattern.key === 'telegram');
    expect(channel?.value.disabled_accounts).toBe(1);
    const cadence = computed.find((pattern) => pattern.kind === 'contact_cadence');
    expect(cadence?.evidence_count).toBe(4);
  });

  it('local model: /api/ai/status resolves the mocked Ollama endpoint over real HTTP', () => {
    expect(bundle.localModel.status.enabled).toBe(true);
    expect(bundle.localModel.status.provider).toBe('local');
    expect(bundle.localModel.status.local.configured).toBe(true);
    expect(bundle.localModel.statusWithProbeConnected.local.reachable).toBe(true);
    expect(bundle.localModel.statusWithProbeConnected.local.host).toBe('127.0.0.1');
    const test = bundle.localModel.testConnection as { data?: { ok?: boolean; provider?: string } };
    expect(test.data?.ok).toBe(true);
    expect(test.data?.provider).toBe('local');
    const chat = bundle.localModel.chat as { provider?: string; model?: string };
    expect(chat.provider).toBe('local');
    expect(chat.model).toBe(OLLAMA_MODEL);
    expect(bundle.localModel.chatRequests.length).toBeGreaterThanOrEqual(2);
    expect(bundle.localModel.chatRequests.some((request) => request.usedTools === false)).toBe(true);
  });

  it('QA: mid-pass provider disconnect degrades to the deterministic path and keeps the draft', () => {
    expect(bundle.transcript.draftPreservation.inputPreserved).toBe(true);
    const up = bundle.transcript.draftPreservation.providerUp as { layer?: string; operation?: { kind?: string; title?: string } };
    const down = bundle.transcript.draftPreservation.providerDown as { layer?: string; operation?: { kind?: string; title?: string; date?: string } };
    expect(up.layer).toBe('primary');
    expect(down.layer).toBe('regex');
    expect(down.operation?.title).toBe(up.operation?.title);
    expect(down.operation?.date).toBe('2026-10-01');
    expect(bundle.transcript.draftPreservation.sourceGuards).toHaveLength(3);

    // The provider really was disconnected: status flips to unreachable and chat reports AI_NETWORK.
    expect(bundle.localModel.afterDisconnect.status.local.reachable).toBe(false);
    expect(bundle.localModel.afterDisconnect.chatErrorCode).toBe('AI_NETWORK');
    // AI ships off by default (plan criterion 14): disabled gateway degrades to the regex layer too.
    expect(bundle.localModel.aiDisabled.enabled).toBe(false);
    expect(bundle.localModel.aiDisabled.chatErrorCode).toBe('AI_DISABLED');
    expect(bundle.localModel.aiDisabled.parseLayer).toBe('regex');
  });

  it('records the four artefacts on disk (non-empty, before the summary re-reads them)', () => {
    expect(bundle.written).toHaveLength(4);
    for (const artefact of bundle.written) {
      expect(artefact.bytes, `${artefact.name} must be non-empty`).toBeGreaterThan(100);
      expect(readFileSync(artefact.path, 'utf8').length).toBeGreaterThan(0);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Summary test: re-reads the recorded artefacts from disk and validates their schema.
// -------------------------------------------------------------------------------------------

const patternSchema = z.object({
  kind: z.string().min(1),
  key: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence_count: z.number().int().min(0),
  value: z.record(z.string(), z.unknown()),
});

const transcriptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('assistant-transcript'),
  generatedAt: z.string().min(1),
  aiEnabled: z.literal(false),
  turns: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        role: z.enum(['user', 'assistant']),
        text: z.string().min(1),
        tool: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .min(8),
  destructive: z.object({
    deleteStatementsBeforeConfirm: z.literal(0),
    deleteStatementsAfterConfirm: z.literal(1),
    secondConfirmHttpStatus: z.literal(409),
  }),
  draftPreservation: z.object({
    degradedUtterance: z.string().min(1),
    providerUp: z.object({ layer: z.literal('primary'), operation: z.unknown() }),
    providerDown: z.object({ layer: z.literal('regex'), operation: z.unknown() }),
    inputPreserved: z.literal(true),
    sourceGuards: z.array(z.object({ file: z.string(), check: z.string(), detail: z.string() })).length(3),
  }),
});

const mcpLogSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('mcp-jsonrpc-log'),
  generatedAt: z.string().min(1),
  transport: z.string().min(1),
  protocolVersion: z.string().min(1),
  serverName: z.literal('timemark'),
  exchanges: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]),
        method: z.string().min(1),
        httpStatus: z.number().int(),
        request: z.unknown(),
        response: z.unknown(),
      }),
    )
    .min(7),
  auditRows: z.number().int().min(1),
});

const patternsSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('patterns'),
  generatedAt: z.string().min(1),
  seed: z.object({ days: z.literal(90), triggerLogs: z.number().int().min(150) }),
  computed: z.array(patternSchema).min(10),
  surfaced: z.array(patternSchema).min(3),
  kindsPresent: z.array(z.string()).min(7),
});

const localModelSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('local-model-status'),
  generatedAt: z.string().min(1),
  endpoint: z.string().min(1),
  model: z.string().min(1),
  status: z.object({
    enabled: z.literal(true),
    provider: z.literal('local'),
    local: z.object({ configured: z.literal(true), model: z.string().min(1), host: z.literal('127.0.0.1') }),
  }),
  statusWithProbeConnected: z.object({ enabled: z.literal(true), local: z.object({ reachable: z.literal(true) }) }),
  testConnection: z.object({}).passthrough(),
  chat: z.object({ provider: z.literal('local'), model: z.string().min(1), content: z.string() }),
  afterDisconnect: z.object({
    status: z.object({ local: z.object({ reachable: z.literal(false) }) }),
    chatErrorCode: z.literal('AI_NETWORK'),
  }),
  aiDisabled: z.object({ enabled: z.literal(false), chatErrorCode: z.literal('AI_DISABLED'), parseLayer: z.literal('regex') }),
  chatRequests: z.array(z.record(z.string(), z.unknown())),
});

describe('task 111 - summary: each recorded artefact is non-empty and schema-valid', () => {
  const readArtefact = (name: string): unknown => {
    const path = `${evidenceDir()}${evidenceDir().endsWith('\\') || evidenceDir().endsWith('/') ? '' : '/'}${name}`;
    const text = readFileSync(path, 'utf8');
    expect(text.trim().length, `${name} is empty`).toBeGreaterThan(0);
    return JSON.parse(text) as unknown;
  };

  it('assistant transcript artefact', () => {
    const parsed = transcriptSchema.safeParse(readArtefact('task-111-assistant-transcript.json'));
    if (!parsed.success) throw new Error(`assistant transcript schema: ${parsed.error.message}`);
    expect(parsed.success).toBe(true);
  });

  it('MCP JSON-RPC log artefact', () => {
    const parsed = mcpLogSchema.safeParse(readArtefact('task-111-mcp-jsonrpc-log.json'));
    if (!parsed.success) throw new Error(`mcp log schema: ${parsed.error.message}`);
    expect(parsed.success).toBe(true);
  });

  it('patterns artefact', () => {
    const parsed = patternsSchema.safeParse(readArtefact('task-111-patterns.json'));
    if (!parsed.success) throw new Error(`patterns schema: ${parsed.error.message}`);
    expect(parsed.success).toBe(true);
  });

  it('local-model status artefact', () => {
    const parsed = localModelSchema.safeParse(readArtefact('task-111-local-model-status.json'));
    if (!parsed.success) throw new Error(`local-model schema: ${parsed.error.message}`);
    expect(parsed.success).toBe(true);
  });
});

afterAll(() => {
  // The mock provider servers are closed by the runners; nothing else holds the loop open.
});
