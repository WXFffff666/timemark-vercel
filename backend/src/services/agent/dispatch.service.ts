import {
  AGENT_TOOLS,
  AGENT_TOOLS_BY_NAME,
  type AgentToolDefinition,
  type AgentToolName,
  type AgentToolScope,
} from '@timemark/shared';
import {
  authorizeAgentToolCall,
  finalizeAgentAudit,
  hashAgentToken,
  normaliseScopes,
  redactAgentArgs,
  tokenScopesAllow,
  writeAgentAudit,
  type AgentAuditEntry,
  type AgentAuthorizationDenied,
  type AgentTokenScope,
} from '../agent-tokens.service.js';
import { createLogger } from '../../utils/logger.js';
import { query } from '../../db/index.js';
import { claimConfirmation, createConfirmation } from './confirmations.service.js';
import { AGENT_TOOL_HANDLERS, type AgentToolResult } from './tool-handlers.js';

const log = createLogger('agent-dispatch');

/**
 * Checkbox 102: the dispatcher for the agent action API. It performs the mandated order
 * **validate -> authorise -> execute -> audit** and owns the two-phase confirmation flow.
 *
 * Two credential shapes are accepted so the in-app assistant (session) and an external agent
 * (Bearer `tmt_` token) share one execution path:
 *   - `token`  -> every call goes through `authorizeAgentToolCall` (scope check + fail-closed
 *                 audit + confirm_required signal) from task 101.
 *   - `session`-> the request is already authenticated as the owning user; the same audit
 *                 helpers (`writeAgentAudit` / `finalizeAgentAudit`) are used, and scope is the
 *                 owner's full admin grant. A session cannot reach `authorizeAgentToolCall`,
 *                 which is token-shaped, so authorisation here is the authenticated session.
 *
 * The confirmation store lives in the database (v56), so the atomic single-use + 2-minute TTL
 * claim survives between the two serverless invocations.
 */

export type AgentCaller =
  | { kind: 'token'; token: string }
  | { kind: 'session'; userId: number };

export interface AgentToolPreview {
  tool: string;
  /** Registry description - "what will change" in human terms. */
  description: string;
  /** Phase-1-validated args, deep-redacted (never a secret). */
  args: unknown;
  expiresAt: string;
}

export type AgentInvocation =
  | { status: 'denied'; httpStatus: number; error: string; requiredScope?: AgentToolScope }
  | { status: 'confirm_required'; confirmationId: string; preview: AgentToolPreview }
  | { status: 'executed'; result: AgentToolResult };

export type AgentConfirmationResult =
  | { status: 'denied'; httpStatus: number; error: string; message?: string }
  | { status: 'executed'; result: AgentToolResult };

/** Used by tests and the route to resolve a raw token's owner + stored scopes. */
export const AGENT_TOKEN_IDENTITY_SQL =
  'SELECT id, user_id, scopes FROM agent_tokens WHERE token_hash = $1';

/** Tools the given coarse grant may call - the `/tools` view for a token. */
export function listAgentToolsForScopes(scopes: readonly AgentTokenScope[]): AgentToolDefinition[] {
  return AGENT_TOOLS.filter((tool) => tokenScopesAllow(scopes, tool.requiredScope));
}

interface TokenIdentity {
  userId: number;
  tokenId: string;
  scopes: AgentTokenScope[];
}

async function resolveTokenIdentity(token: string): Promise<TokenIdentity | null> {
  const result = await query(AGENT_TOKEN_IDENTITY_SQL, [hashAgentToken(token)]);
  const row = result.rows[0] as { id: string; user_id: number; scopes: unknown } | undefined;
  if (!row) return null;
  return { userId: Number(row.user_id), tokenId: row.id, scopes: normaliseScopes(row.scopes) };
}

/** Scopes of the caller, or null when a token is unknown. Session = full owner grant. */
export async function resolveCallerScopes(caller: AgentCaller): Promise<AgentTokenScope[] | null> {
  if (caller.kind === 'session') return ['admin'];
  const identity = await resolveTokenIdentity(caller.token);
  return identity ? identity.scopes : null;
}

function buildPreview(definition: AgentToolDefinition, args: Record<string, unknown>): AgentToolPreview {
  let redacted: unknown = {};
  try {
    redacted = JSON.parse(redactAgentArgs(args));
  } catch {
    redacted = { note: 'args not serialisable' };
  }
  return { tool: definition.name, description: definition.description, args: redacted, expiresAt: '' };
}

/** Fail-closed audit insert; returns null when the row could not be written. */
async function tryWriteAudit(entry: AgentAuditEntry): Promise<string | null> {
  try {
    return await writeAgentAudit(entry);
  } catch (error) {
    log.warn({ err: error, tool: entry.tool, decision: entry.decision }, 'agent audit write failed');
    return null;
  }
}

function denyFromAuth(auth: AgentAuthorizationDenied): AgentInvocation {
  return { status: 'denied', httpStatus: auth.status, error: auth.reason, requiredScope: auth.requiredScope };
}

async function executeAndFinalize(
  tool: AgentToolName,
  args: Record<string, unknown>,
  userId: number,
  auditId: string,
): Promise<AgentToolResult> {
  const handler = AGENT_TOOL_HANDLERS[tool];
  const started = Date.now();
  let result: AgentToolResult;
  try {
    result = await handler({ userId, args });
  } catch (error) {
    log.warn({ err: error, tool }, 'agent tool handler threw');
    result = { ok: false, code: 'execution_failed', message: '执行失败，请稍后重试', status: 500 };
  }
  try {
    await finalizeAgentAudit({
      auditId,
      result: result.ok ? 'ok' : 'error',
      errorCode: result.ok ? null : result.code,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    // The action already ran; a failed finalize must not turn success into a 500.
    log.warn({ err: error, tool, auditId }, 'failed to finalize agent audit');
  }
  return result;
}

/**
 * Validate -> authorise -> (confirm | execute) -> audit.
 * A `requiresConfirmation` tool never runs here: it returns `confirm_required` with a preview.
 */
export async function invokeTool(input: {
  caller: AgentCaller;
  tool: string;
  rawArgs: unknown;
  requestId: string | null;
}): Promise<AgentInvocation> {
  const definition = AGENT_TOOLS_BY_NAME.get(input.tool as AgentToolName);
  if (!definition) return { status: 'denied', httpStatus: 404, error: 'unknown_tool' };

  const parsed = definition.inputSchema.safeParse(input.rawArgs ?? {});
  if (!parsed.success) return { status: 'denied', httpStatus: 400, error: 'invalid_args' };
  const args = parsed.data as Record<string, unknown>;

  if (input.caller.kind === 'token') {
    const auth = await authorizeAgentToolCall({
      token: input.caller.token,
      tool: definition.name,
      args,
      requestId: input.requestId,
    });
    if (auth.allowed) {
      const result = await executeAndFinalize(definition.name, args, auth.userId, auth.auditId);
      return { status: 'executed', result };
    }
    if (auth.reason === 'confirm_required') {
      const identity = await resolveTokenIdentity(input.caller.token);
      if (!identity) return { status: 'denied', httpStatus: 401, error: 'invalid_token' };
      const created = await createConfirmation({
        userId: identity.userId,
        tokenId: identity.tokenId,
        tool: definition.name,
        args,
      });
      const preview = { ...buildPreview(definition, args), expiresAt: created.expiresAt.toISOString() };
      return { status: 'confirm_required', confirmationId: created.id, preview };
    }
    return denyFromAuth(auth);
  }

  // Session caller: the authenticated owner. A session cannot be handed to
  // `authorizeAgentToolCall` (which is token-shaped), so the owner's grant is implicit and the
  // same audit helpers record the decision.
  const confirmationRequired = definition.requiresConfirmation;
  const auditId = await tryWriteAudit({
    userId: input.caller.userId,
    tokenId: null,
    tool: definition.name,
    args,
    decision: confirmationRequired ? 'confirm_required' : 'allowed',
    requestId: input.requestId,
  });
  if (!auditId) return { status: 'denied', httpStatus: 403, error: 'audit_unavailable' };

  if (confirmationRequired) {
    const created = await createConfirmation({
      userId: input.caller.userId,
      tokenId: null,
      tool: definition.name,
      args,
    });
    const preview = { ...buildPreview(definition, args), expiresAt: created.expiresAt.toISOString() };
    return { status: 'confirm_required', confirmationId: created.id, preview };
  }

  const result = await executeAndFinalize(definition.name, args, input.caller.userId, auditId);
  return { status: 'executed', result };
}

/**
 * Phase 2. Atomically consumes the confirmation, re-validates the credential, executes the
 * recorded tool and audits the outcome. The claim is single-use and TTL-bounded in SQL, so a
 * concurrent or replayed confirm can never run the handler twice.
 */
export async function confirmTool(input: {
  caller: AgentCaller;
  confirmationId: string;
  requestId: string | null;
}): Promise<AgentConfirmationResult> {
  let userId: number;
  let tokenId: string | null;
  let token: string | null = null;

  if (input.caller.kind === 'token') {
    const identity = await resolveTokenIdentity(input.caller.token);
    if (!identity) return { status: 'denied', httpStatus: 401, error: 'invalid_token' };
    userId = identity.userId;
    tokenId = identity.tokenId;
    token = input.caller.token;
  } else {
    userId = input.caller.userId;
    tokenId = null;
  }

  const claim = await claimConfirmation(input.confirmationId, userId);
  if (!claim.claimed) {
    if (claim.reason === 'not_found') return { status: 'denied', httpStatus: 404, error: 'confirmation_not_found' };
    if (claim.reason === 'already_used') return { status: 'denied', httpStatus: 409, error: 'confirmation_already_used' };
    return { status: 'denied', httpStatus: 410, error: 'confirmation_expired', message: '确认已过期，请重新发起' };
  }

  const definition = AGENT_TOOLS_BY_NAME.get(claim.tool);
  if (!definition) return { status: 'denied', httpStatus: 404, error: 'unknown_tool' };
  const args = (claim.args ?? {}) as Record<string, unknown>;

  // Re-validate a token credential at confirm time (it may have been revoked/expired between
  // the phases). A confirmation-required tool still reports `confirm_required`, which is the
  // expected signal here; any real denial aborts - the row is already consumed, so fail closed.
  if (token) {
    const auth = await authorizeAgentToolCall({
      token,
      tool: definition.name,
      args,
      requestId: input.requestId,
    });
    if (!auth.allowed && auth.reason !== 'confirm_required') {
      return { status: 'denied', httpStatus: auth.status, error: auth.reason };
    }
  }

  const auditId = await tryWriteAudit({
    userId,
    tokenId,
    tool: definition.name,
    args,
    decision: 'allowed',
    requestId: input.requestId,
  });
  if (!auditId) return { status: 'denied', httpStatus: 403, error: 'audit_unavailable' };

  const result = await executeAndFinalize(definition.name, args, userId, auditId);
  return { status: 'executed', result };
}
