import { query } from '../../db/index.js';
import type { AgentToolName } from '@timemark/shared';

/**
 * Checkbox 102: the durable, single-use, TTL-bounded confirmation store for the agent action
 * API (`agent_confirmations`, migration v56).
 *
 * Why a DB table and not module state: on Vercel every request may run in a fresh invocation,
 * so an in-memory Map would lose a pending confirmation between the two HTTP calls. Persisting
 * also lets the single-use + TTL guarantee live in ONE conditional UPDATE, which is what makes
 * a concurrent double-confirm execute at most once.
 */

/** A confirmation older than this is refused. Kept in sync with the SQL `make_interval`. */
export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export interface CreatedConfirmation {
  id: string;
  expiresAt: Date;
}

export type ConfirmationClaim =
  | { claimed: true; tool: AgentToolName; args: unknown }
  | { claimed: false; reason: 'not_found' | 'expired' | 'already_used' };

/**
 * Every statement this service emits. Exported so tests (and any engine harness) execute the
 * exact shipped text rather than a paraphrase.
 */
export const CONFIRMATION_SQL = {
  insert: `
INSERT INTO agent_confirmations (user_id, token_id, tool, args, expires_at)
VALUES ($1, $2::uuid, $3, $4::jsonb, now() + make_interval(secs => $5::double precision))
RETURNING id, expires_at`,
  // Single-use + TTL, both enforced by the WHERE clause in the data layer: only a row that is
  // still `pending` AND unexpired flips to `consumed`, so a second (or concurrent) confirm
  // matches zero rows and can never run the handler twice.
  claim: `
UPDATE agent_confirmations
SET status = 'consumed', consumed_at = now()
WHERE id = $1::uuid AND user_id = $2 AND status = 'pending' AND expires_at > now()
RETURNING id, tool, args`,
  // Only consulted after a failed claim to explain WHY it failed (clear error message).
  inspect: `
SELECT status, (expires_at <= now()) AS expired
FROM agent_confirmations
WHERE id = $1::uuid AND user_id = $2`,
} as const;

function toDate(value: unknown): Date {
  const ms = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return new Date(Number.isFinite(ms) ? ms : Date.now());
}

/**
 * Record one pending confirmation. The args are the phase-1-validated inputs the handler will
 * receive; they are never a handler name or any free-form query/exec surface.
 */
export async function createConfirmation(input: {
  userId: number;
  tokenId: string | null;
  tool: AgentToolName;
  args: unknown;
  ttlMs?: number;
}): Promise<CreatedConfirmation> {
  const ttlSec = Math.max(1, Math.round((input.ttlMs ?? CONFIRMATION_TTL_MS) / 1000));
  const result = await query(CONFIRMATION_SQL.insert, [
    input.userId,
    input.tokenId,
    input.tool,
    JSON.stringify(input.args ?? {}),
    ttlSec,
  ]);
  const row = result.rows[0] as { id?: string; expires_at?: unknown } | undefined;
  if (!row?.id) throw new Error('failed to create agent confirmation');
  return { id: String(row.id), expiresAt: toDate(row.expires_at) };
}

/**
 * Atomically consume a confirmation. Exactly one caller can win the conditional UPDATE; every
 * other caller (concurrent, replay, expired) gets `claimed: false` with a reason.
 */
export async function claimConfirmation(id: string, userId: number): Promise<ConfirmationClaim> {
  const claim = await query(CONFIRMATION_SQL.claim, [id, userId]);
  const row = claim.rows[0] as { tool?: string; args?: unknown } | undefined;
  if (row?.tool) {
    return { claimed: true, tool: row.tool as AgentToolName, args: row.args ?? {} };
  }

  const inspect = await query(CONFIRMATION_SQL.inspect, [id, userId]);
  const info = inspect.rows[0] as { status?: string; expired?: boolean } | undefined;
  if (!info) return { claimed: false, reason: 'not_found' };
  if (info.status === 'consumed') return { claimed: false, reason: 'already_used' };
  return { claimed: false, reason: 'expired' };
}
