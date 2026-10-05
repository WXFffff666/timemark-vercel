import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AGENT_TOOLS, type AgentToolDefinition } from '@timemark/shared';
import { createLogger } from '../../utils/logger.js';

/**
 * Task 110 (a): rug-pull defence for the agent tool registry.
 *
 * A "rug pull" against a tool-calling client works by silently CHANGING a tool after the
 * client approved it: a description that acquires new instructions, a wider `inputSchema`,
 * a `destructive` flag flipped to false, or an extra tool. The listed description is what the
 * caller's model sees and trusts, so any post-approval edit is a supply-chain event.
 *
 * Defence: the registry (`shared/src/agent-tools.ts`, checkbox 100) is canonicalised and
 * hashed with SHA-256, and the expected digest is PINNED below as a repo constant. The check
 * runs once per process at dispatcher module load (serverless: once per cold start) and:
 *
 *   - logs an ERROR with { expected, actual, toolCount } when the digest changed, and
 *   - NEVER blocks a request. DECISION (task 110): drift is a deploy-time fact - the code that
 *     changed the registry is already running, so refusing every call at request time would
 *     turn an observability signal into an outage and cannot restore the old registry. The
 *     pinned value ALSO lives in `backend/src/test/agent-hardening.test.ts`, which fails the
 *     suite on drift, so a changed registry cannot land unnoticed via CI either.
 *
 * The canonical form is a stable (key-sorted) JSON projection of every field a caller can
 * observe or act on: name, description, inputSchema (rendered to JSON Schema), requiredScope,
 * destructive, requiresConfirmation and the handler binding string. Whitespace/description
 * edits flip the digest, so an accidental edit cannot masquerade as "no change".
 *
 * There is deliberately no external alerting sink in this deployment (recorded in
 * .omo/notepads/timemark-vercel-expansion/issues.md); pino at error level is the alert.
 */
const log = createLogger('agent-registry-integrity');

/**
 * sha256 of the canonicalised registry. Recompute with
 * `computeAgentToolRegistryHash()` after ANY deliberate registry edit and update this pin
 * plus the drift test in the same commit.
 */
export const AGENT_TOOL_REGISTRY_SHA256 =
  'b3f843112b8a2d7fe47cde5e12d60b056ca4f0b7640e42b54ea9839d74f65dc4';

/** Deterministic JSON: object keys are sorted at every depth, so digest order never varies. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/** One registry entry projected to exactly the fields a caller can observe or act on. */
function canonicalToolEntry(definition: AgentToolDefinition): string {
  let inputSchema: unknown;
  try {
    inputSchema = z.toJSONSchema(definition.inputSchema);
  } catch {
    // A schema zod cannot render still participates via its own text so the entry stays
    // represented in the digest (never silently omitted).
    inputSchema = String(definition.inputSchema);
  }
  return stableStringify({
    name: definition.name,
    description: definition.description,
    inputSchema,
    requiredScope: definition.requiredScope,
    destructive: definition.destructive,
    requiresConfirmation: definition.requiresConfirmation,
    handler: definition.handler,
  });
}

/** Canonical sha256 (hex) of a tool registry, in registry order. */
export function computeAgentToolRegistryHash(
  definitions: readonly AgentToolDefinition[] = AGENT_TOOLS,
): string {
  return createHash('sha256')
    .update(stableStringify(definitions.map((definition) => canonicalToolEntry(definition))))
    .digest('hex');
}

export interface AgentRegistryDrift {
  expected: string;
  actual: string;
  toolCount: number;
}

/**
 * The alert sink. Production: ONE error-level pino line (this deployment has no external
 * alerting sink - see the module header). Exposed as an object so a test can spy on the
 * default reporting path without re-plumbing pino.
 */
export const agentRegistryDriftSink = {
  report(drift: AgentRegistryDrift): void {
    log.error(
      drift,
      'agent tool registry drift detected: tool definitions no longer match the pinned sha256 (rug-pull?)',
    );
  },
};

/** The default alert: routes through the sink above. Never throws. */
export function reportAgentRegistryDrift(drift: AgentRegistryDrift): void {
  agentRegistryDriftSink.report(drift);
}

export interface AgentRegistryVerification {
  ok: boolean;
  expected: string;
  actual: string;
}

/**
 * Compare a registry against the pin. `onDrift` is injectable so tests can assert the alert
 * without capturing pino output; production uses the error-level reporter.
 */
export function verifyAgentToolRegistry(
  definitions: readonly AgentToolDefinition[] = AGENT_TOOLS,
  onDrift: (drift: AgentRegistryDrift) => void = reportAgentRegistryDrift,
): AgentRegistryVerification {
  const expected = AGENT_TOOL_REGISTRY_SHA256;
  const actual = computeAgentToolRegistryHash(definitions);
  const ok = actual === expected;
  if (!ok) onDrift({ expected, actual, toolCount: definitions.length });
  return { ok, expected, actual };
}
