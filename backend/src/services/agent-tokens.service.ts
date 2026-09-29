/**
 * Checkbox 101: scoped, revocable agent tokens + their audit log.
 *
 * Security invariants (pinned by backend/src/test/agent-tokens.test.ts):
 *   - A token is minted ONCE and its raw value is returned ONCE. Only the SHA-256 hex hash
 *     is stored, so a leaked database never yields a usable credential.
 *   - The default grant is `read` ONLY. A `read` token can never invoke a mutation.
 *   - Token scope is checked against the tool's `requiredScope` from the single registry
 *     (shared/src/agent-tools.ts, checkbox 100) BEFORE any handler body runs.
 *   - Every decision - allowed, denied or confirm_required - is written to
 *     `agent_audit_logs`, and the row write is VERIFIED before an `allowed` decision is
 *     returned. If the audit write fails, the call is DENIED (fail closed): no action may
 *     run unaudited.
 *   - `args_redacted` reuses the bot redaction helper; a raw token / key / document shape is
 *     never persisted in the audit args.
 *   - Revocation and expiry are evaluated with epoch-millisecond comparisons (or in SQL),
 *     never by slicing a UTC ISO string (standing lesson from issues.md).
 *
 * This module is pure machinery: it does NOT execute tools. Task 102's dispatcher calls
 * `authorizeAgentToolCall` first and `finalizeAgentAudit` afterwards.
 */

import { randomBytes, createHash } from 'node:crypto';
import {
  AGENT_TOOLS_BY_NAME,
  AGENT_TOOL_SCOPES,
  type AgentToolName,
  type AgentToolScope,
} from '@timemark/shared';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { redactSecrets, REDACTION_PLACEHOLDER } from './bot/redaction.js';

const log = createLogger('agent-tokens');

/** Coarse grant a token carries. Least privilege: the default is `read` only. */
export const AGENT_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export type AgentTokenScope = (typeof AGENT_TOKEN_SCOPES)[number];

/** A freshly minted token can only read until the owner widens it explicitly. */
export const DEFAULT_AGENT_TOKEN_SCOPES: readonly AgentTokenScope[] = ['read'];

/** Prefix so a leaked token is greppable in logs/secret scanners. */
const TOKEN_PREFIX = 'tmt_';
const TOKEN_BYTES = 32;

const TOOL_READ_SCOPES = new Set<AgentToolScope>(AGENT_TOOL_SCOPES.filter((scope) => scope.endsWith(':read')));
const TOOL_WRITE_SCOPES = new Set<AgentToolScope>(AGENT_TOOL_SCOPES.filter((scope) => scope.endsWith(':write')));

/** Redact our own token shape even though args should never carry one. */
const AGENT_TOKEN_RE = new RegExp(`${TOKEN_PREFIX}[A-Za-z0-9]{16,}`, 'g');

/** Key names whose VALUE is a credential and must never be persisted, whatever its shape. */
const SENSITIVE_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;

export interface AgentTokenView {
  id: string;
  name: string;
  scopes: AgentTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

interface AgentTokenRow {
  id: string;
  user_id: number;
  name: string;
  token_hash: string;
  scopes: string[] | null;
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
  expires_at: string | Date | null;
}

export type AgentAuditDecision = 'allowed' | 'denied' | 'confirm_required';
export type AgentAuditResult = 'ok' | 'error';

/** SHA-256 (hex) of the raw token - the ONLY representation that is ever persisted. */
export function hashAgentToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Mint a raw token value. Callers MUST show it once and never store it. */
export function generateAgentTokenValue(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;
}

export function isAgentTokenScope(value: unknown): value is AgentTokenScope {
  return typeof value === 'string' && (AGENT_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Normalise a client-supplied grant list; unknown scopes are dropped, empty -> `read`. */
export function normaliseScopes(input: unknown): AgentTokenScope[] {
  const list = Array.isArray(input) ? input.filter(isAgentTokenScope) : [];
  const unique = [...new Set(list)];
  if (unique.length === 0) return [...DEFAULT_AGENT_TOKEN_SCOPES];
  return unique;
}

function parseStoredScopes(value: unknown): AgentTokenScope[] {
  return normaliseScopes(value);
}

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toView(row: AgentTokenRow): AgentTokenView {
  return {
    id: row.id,
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    lastUsedAt: toIso(row.last_used_at),
    revokedAt: toIso(row.revoked_at),
    expiresAt: toIso(row.expires_at),
  };
}

/** True when the required tool scope is inside the token's coarse grant. */
export function tokenScopesAllow(
  scopes: readonly AgentTokenScope[],
  requiredScope: AgentToolScope,
): boolean {
  return scopes.some((scope) => {
    if (scope === 'admin') return true;
    if (scope === 'write') return TOOL_READ_SCOPES.has(requiredScope) || TOOL_WRITE_SCOPES.has(requiredScope);
    return TOOL_READ_SCOPES.has(requiredScope);
  });
}

/** The required scope for a tool name, or null when the name is not in the registry. */
export function requiredScopeForTool(tool: string): AgentToolScope | null {
  const definition = AGENT_TOOLS_BY_NAME.get(tool as AgentToolName);
  return definition ? definition.requiredScope : null;
}

function toolRequiresConfirmation(tool: string): boolean {
  return AGENT_TOOLS_BY_NAME.get(tool as AgentToolName)?.requiresConfirmation ?? false;
}

/** Deep-redact every string value in the args, then serialise to guaranteed-valid JSON. */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    return redactSecrets(value).text.replace(AGENT_TOKEN_RE, REDACTION_PLACEHOLDER);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let index = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (index >= 100) break;
      index += 1;
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTION_PLACEHOLDER : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redact args via the shared bot redactor; never returns a token, key or full body. */
export function redactAgentArgs(args: unknown): string {
  try {
    return JSON.stringify(redactValue(args ?? {}));
  } catch {
    return '{"error":"args not serialisable"}';
  }
}

// --- Token lifecycle (used by the settings route) -----------------------------------

export interface CreatedAgentToken {
  /** The RAW token - returned exactly once, never retrievable again. */
  token: string;
  view: AgentTokenView;
}

export async function createAgentToken(
  userId: number,
  name: string,
  scopes?: unknown,
): Promise<CreatedAgentToken> {
  const raw = generateAgentTokenValue();
  const tokenHash = hashAgentToken(raw);
  const grants = normaliseScopes(scopes);
  const result = await query(
    `INSERT INTO agent_tokens (user_id, name, token_hash, scopes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, name, token_hash, scopes, created_at, last_used_at, revoked_at, expires_at`,
    [userId, name, tokenHash, grants],
  );
  const row = result.rows[0] as AgentTokenRow | undefined;
  if (!row) throw new Error('failed to create agent token');
  return { token: raw, view: toView(row) };
}

export async function listAgentTokens(userId: number): Promise<AgentTokenView[]> {
  const result = await query(
    `SELECT id, user_id, name, token_hash, scopes, created_at, last_used_at, revoked_at, expires_at
     FROM agent_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return (result.rows as AgentTokenRow[]).map(toView);
}

export async function revokeAgentToken(userId: number, id: string): Promise<boolean> {
  const result = await query(
    `UPDATE agent_tokens SET revoked_at = now()
     WHERE id = $1::uuid AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function renameAgentToken(userId: number, id: string, name: string): Promise<boolean> {
  const result = await query(
    `UPDATE agent_tokens SET name = $3
     WHERE id = $1::uuid AND user_id = $2
     RETURNING id`,
    [id, userId, name],
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Audit log ----------------------------------------------------------------------

export interface AgentAuditEntry {
  userId: number | null;
  tokenId: string | null;
  tool: string;
  args: unknown;
  decision: AgentAuditDecision;
  result?: AgentAuditResult | null;
  errorCode?: string | null;
  durationMs?: number | null;
  requestId?: string | null;
}

/**
 * Insert one audit row and VERIFY it persisted. Returns the row id.
 * Throws when the INSERT produced no row - callers must treat that as fail-closed.
 */
export async function writeAgentAudit(entry: AgentAuditEntry): Promise<string> {
  const result = await query(
    `INSERT INTO agent_audit_logs
       (user_id, token_id, tool, args_redacted, decision, result, error_code, duration_ms, request_id)
     VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      entry.userId,
      entry.tokenId,
      entry.tool,
      redactAgentArgs(entry.args),
      entry.decision,
      entry.result ?? null,
      entry.errorCode ?? null,
      entry.durationMs ?? null,
      entry.requestId ?? null,
    ],
  );
  const id = result.rows[0]?.id as string | number | undefined;
  if (id === undefined || id === null) {
    throw new Error('agent audit row was not persisted');
  }
  return String(id);
}

/** Update the outcome fields of an already-recorded audit row (same row, still one row). */
export async function finalizeAgentAudit(input: {
  auditId: string;
  result: AgentAuditResult;
  errorCode?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  await query(
    `UPDATE agent_audit_logs SET result = $2, error_code = $3, duration_ms = $4 WHERE id = $1::bigint`,
    [input.auditId, input.result, input.errorCode ?? null, input.durationMs ?? null],
  );
}

// --- Authorisation seam (called by task 102's dispatcher) -----------------------------

export type AgentAuthDenyReason =
  | 'invalid_token'
  | 'token_revoked'
  | 'token_expired'
  | 'unknown_tool'
  | 'scope_denied'
  | 'confirm_required'
  | 'audit_unavailable';

export interface AuthorizeAgentToolCallInput {
  token: string;
  tool: string;
  args?: unknown;
  requestId?: string | null;
}

export interface AgentAuthorizationAllowed {
  allowed: true;
  userId: number;
  tokenId: string;
  auditId: string;
  requiredScope: AgentToolScope;
}

export interface AgentAuthorizationDenied {
  allowed: false;
  reason: AgentAuthDenyReason;
  status: 401 | 403 | 409;
  requiredScope?: AgentToolScope;
}

export type AgentAuthorization = AgentAuthorizationAllowed | AgentAuthorizationDenied;

async function findTokenRowByHash(tokenHash: string): Promise<AgentTokenRow | null> {
  const result = await query(
    `SELECT id, user_id, name, token_hash, scopes, created_at, last_used_at, revoked_at, expires_at
     FROM agent_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return (result.rows[0] as AgentTokenRow | undefined) ?? null;
}

/**
 * Epoch-ms expiry test - never a string slice of a UTC ISO value. Exported so the
 * credential resolver (and the route gates that re-check revocation/expiry) share ONE
 * definition instead of forking the comparison.
 */
export function isAgentTokenExpired(value: unknown, nowMs: number = Date.now()): boolean {
  if (value === null || value === undefined) return false;
  const expiresMs = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

/**
 * Record a denial and return the fail-closed decision. If even the denial cannot be
 * audited, the call is still denied - an unaudited action must never proceed.
 */
async function denyWithAudit(
  entry: Omit<AgentAuditEntry, 'decision' | 'result'>,
  reason: AgentAuthDenyReason,
  status: AgentAuthorizationDenied['status'],
  requiredScope?: AgentToolScope,
): Promise<AgentAuthorizationDenied> {
  try {
    await writeAgentAudit({ ...entry, decision: 'denied', errorCode: reason });
  } catch (error) {
    log.warn({ err: error, tool: entry.tool, reason }, 'agent audit write failed on denial');
    return { allowed: false, reason: 'audit_unavailable', status: 403, requiredScope };
  }
  return { allowed: false, reason, status, requiredScope };
}

/**
 * Authenticate a token, check its grant against the tool's `requiredScope`, and write the
 * decision to the audit log. An `allowed` decision is returned ONLY after the audit row is
 * verified; a failed audit write denies the call (fail closed).
 */
export async function authorizeAgentToolCall(
  input: AuthorizeAgentToolCallInput,
): Promise<AgentAuthorization> {
  const raw = typeof input.token === 'string' ? input.token.trim() : '';
  const requestId = input.requestId ?? null;
  const requiredScope = requiredScopeForTool(input.tool);

  const row = raw ? await findTokenRowByHash(hashAgentToken(raw)) : null;
  const userId = row ? Number(row.user_id) : null;
  const tokenId = row ? row.id : null;
  const base = { userId, tokenId, tool: input.tool, args: input.args, requestId };

  if (!row) {
    return denyWithAudit(base, 'invalid_token', 401);
  }
  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return denyWithAudit(base, 'token_revoked', 401);
  }
  if (isAgentTokenExpired(row.expires_at)) {
    return denyWithAudit(base, 'token_expired', 401);
  }
  if (!requiredScope) {
    return denyWithAudit(base, 'unknown_tool', 403);
  }
  const scopes = parseStoredScopes(row.scopes);
  if (!tokenScopesAllow(scopes, requiredScope)) {
    return denyWithAudit(base, 'scope_denied', 403, requiredScope);
  }

  // Confirmation-required tools are recorded but never auto-run by the dispatcher.
  if (toolRequiresConfirmation(input.tool)) {
    try {
      await writeAgentAudit({ ...base, decision: 'confirm_required' });
    } catch (error) {
      log.warn({ err: error, tool: input.tool }, 'agent audit write failed on confirm_required');
      return { allowed: false, reason: 'audit_unavailable', status: 403, requiredScope };
    }
    return { allowed: false, reason: 'confirm_required', status: 409, requiredScope };
  }

  let auditId: string;
  try {
    auditId = await writeAgentAudit({ ...base, decision: 'allowed' });
  } catch (error) {
    // The action would be unaudited - deny it.
    log.warn({ err: error, tool: input.tool }, 'agent audit write failed; denying call (fail closed)');
    return { allowed: false, reason: 'audit_unavailable', status: 403, requiredScope };
  }

  try {
    await query('UPDATE agent_tokens SET last_used_at = now() WHERE id = $1::uuid', [row.id]);
  } catch (error) {
    log.warn({ err: error, tokenId: row.id }, 'failed to update agent token last_used_at');
  }

  return { allowed: true, userId: Number(row.user_id), tokenId: row.id, auditId, requiredScope };
}

// --- Credential resolution for the read-only gates -----------------------------------------

/**
 * Task 110, closing the recorded 103/104 gaps: the dispatcher re-validates revocation/expiry
 * on every `tools/call`, but the read-only gates (`GET /api/agent/tools`, MCP `tools/list` /
 * `resources/list` / `resources/read`) previously resolved only scopes - so a revoked or
 * expired token could still enumerate tools and inline whole resource payloads. This resolver
 * returns the SAME credential verdict the dispatcher would, so every gate answers revoked and
 * expired distinctly (`token_revoked` / `token_expired`) instead of silently serving data.
 *
 * `tools/call` deliberately keeps its dispatcher path rather than being short-circuited here:
 * there the denial is ALSO written to `agent_audit_logs` (fail-closed audit), and a
 * pre-dispatch gate must not duplicate or replace that row.
 */
const AGENT_TOKEN_CREDENTIAL_SQL =
  'SELECT id, user_id, scopes, revoked_at, expires_at FROM agent_tokens WHERE token_hash = $1';

export type AgentTokenCredential =
  | { status: 'ok'; userId: number; tokenId: string; scopes: AgentTokenScope[] }
  | { status: 'unknown' | 'revoked' | 'expired' };

export async function resolveAgentTokenCredential(token: string): Promise<AgentTokenCredential> {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return { status: 'unknown' };
  const result = await query(AGENT_TOKEN_CREDENTIAL_SQL, [hashAgentToken(raw)]);
  const row = result.rows[0] as
    | { id: string; user_id: number; scopes: unknown; revoked_at?: unknown; expires_at?: unknown }
    | undefined;
  if (!row) return { status: 'unknown' };
  if (row.revoked_at !== null && row.revoked_at !== undefined) return { status: 'revoked' };
  if (isAgentTokenExpired(row.expires_at)) return { status: 'expired' };
  return { status: 'ok', userId: Number(row.user_id), tokenId: row.id, scopes: parseStoredScopes(row.scopes) };
}
