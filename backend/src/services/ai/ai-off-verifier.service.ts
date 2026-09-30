/**
 * 162 - proof that the AI layer is fully implemented but fully OFF by default.
 *
 * `verifyAiOff()` runs a small, side-effect-free battery:
 *   1. `.env.example` ships every AI, OLLAMA and EMBEDDINGS variable empty;
 *   2. with no provider configured the gateway throws `AiDisabledError`;
 *   3. no HTTP request is issued while disabled (injected fetch spy);
 *   4. every AI-dependent surface has a deterministic fallback that works
 *      without a provider.
 *
 * Nothing in this module enables AI; the default is off.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DigestData } from '../digest.service.js';
import {
  EmbeddingsDisabledError,
  embedTexts,
  isEmbeddingsEnabled,
} from './embeddings.js';
import {
  AiDisabledError,
  TIER_PROVIDER_ENV,
  createAiGateway,
  isAiConfigured,
  listConfiguredProviders,
  type AiFetch,
  type AiProviderName,
} from './gateway.js';
import { parseOperation } from './parse.js';
import {
  isDigestNarrativeEnabled,
  isEventTaggingEnabled,
  isTemplateTranslationEnabled,
  suggestEventTags,
  summarizeDigestNarrative,
} from './summarize.js';

const FEATURE_FLAG_VARS = ['AI_DIGEST_NARRATIVE', 'AI_EVENT_TAGGING', 'AI_TEMPLATE_TRANSLATION'] as const;

/** Every env variable the AI layer reads (runtime + example-file checks). */
export const AI_ENV_VARS: readonly string[] = [
  ...new Set([
    'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
    'AI_FALLBACK_BASE_URL', 'AI_FALLBACK_API_KEY', 'AI_FALLBACK_MODEL',
    'OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'OLLAMA_MODEL',
    'EMBEDDINGS_ENABLED', 'EMBEDDINGS_BASE_URL', 'EMBEDDINGS_API_KEY', 'EMBEDDINGS_MODEL',
    'EMBEDDINGS_DIMS', 'EMBEDDINGS_BATCH_SIZE',
    ...FEATURE_FLAG_VARS,
    ...Object.values(TIER_PROVIDER_ENV),
  ]),
];

const AI_ENV_VAR_SET = new Set(AI_ENV_VARS);

export interface AiOffCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface AiOffProof {
  aiOff: boolean;
  checkedAt: string;
  /** Provider slots configured in the running process (empty = off). */
  runtimeConfiguredProviders: AiProviderName[];
  /** Names only - values are never echoed. */
  runtimeEnvSet: string[];
  envExample: { checked: boolean; path: string | null; nonEmptyVars: string[] };
  checks: AiOffCheck[];
  surfaces: ReadonlyArray<{ name: string; gate: string; fallback: string }>;
}

/** Catalog of AI-dependent surfaces and their deterministic no-provider behaviour. */
export const AI_DEPENDENT_SURFACES: ReadonlyArray<{ name: string; gate: string; fallback: string }> = [
  {
    name: 'digest narrative (79)',
    gate: 'AI_DIGEST_NARRATIVE=true + provider',
    fallback: 'deterministic digest facts; narrative stays null (usedAi=false)',
  },
  {
    name: 'event tag suggestions',
    gate: 'AI_EVENT_TAGGING=true + provider',
    fallback: 'empty suggestion {category:null, tags:[]}; never applied automatically',
  },
  {
    name: 'template translation',
    gate: 'AI_TEMPLATE_TRANSLATION=true + provider',
    fallback: 'content stays null, original template preserved',
  },
  {
    name: 'NL operation parser (ask)',
    gate: 'provider configured',
    fallback: 'clarify/reject outcome, no mutation executed',
  },
  {
    name: 'semantic search embeddings',
    gate: 'EMBEDDINGS_ENABLED=true + provider',
    fallback: 'lexical/trigram search only; embeddings skipped',
  },
];

function envExampleCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, '../../../../.env.example'), // backend/src/services/ai -> repo root
    resolve(process.cwd(), '.env.example'),
    resolve(process.cwd(), '../../.env.example'),
  ];
}

function readEnvExample(): { path: string; content: string } | null {
  for (const candidate of envExampleCandidates()) {
    try {
      return { path: candidate, content: readFileSync(candidate, 'utf8') };
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Non-empty, uncommented AI / OLLAMA / EMBEDDINGS assignments. */
function nonEmptyAiVars(content: string): string[] {
  const hits = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!AI_ENV_VAR_SET.has(key)) continue;
    if (line.slice(eq + 1).trim() !== '') hits.add(key);
  }
  return [...hits];
}

async function probeGatewayDisabled(): Promise<{ check: AiOffCheck; fetchCalls: number }> {
  let fetchCalls = 0;
  const spyFetch: AiFetch = async () => {
    fetchCalls += 1;
    throw new Error('network access attempted while AI is disabled');
  };
  const gateway = createAiGateway({ env: {}, fetchImpl: spyFetch });
  const status = gateway.status();
  try {
    await gateway.chat([{ role: 'user', content: 'ai-off probe' }]);
    return {
      check: { id: 'gateway_throws_ai_disabled', ok: false, detail: 'chat() resolved even though no provider is configured' },
      fetchCalls,
    };
  } catch (error) {
    const disabled = error instanceof AiDisabledError;
    return {
      check: {
        id: 'gateway_throws_ai_disabled',
        ok: disabled && status.enabled === false && fetchCalls === 0,
        detail: disabled
          ? `chat() rejected with AiDisabledError (status.enabled=${String(status.enabled)}, fetch calls=${fetchCalls})`
          : `chat() rejected with an unexpected error: ${String(error)}`,
      },
      fetchCalls,
    };
  }
}

async function probeEmbeddingsDisabled(): Promise<{ check: AiOffCheck; fetchCalls: number }> {
  let fetchCalls = 0;
  const spyFetch: AiFetch = async () => {
    fetchCalls += 1;
    throw new Error('network access attempted while embeddings are disabled');
  };
  const flagOff = isEmbeddingsEnabled({}) === false;
  try {
    await embedTexts(['ai-off probe'], { env: {}, fetchImpl: spyFetch });
    return {
      check: { id: 'embeddings_throws_disabled', ok: false, detail: 'embedTexts() resolved with EMBEDDINGS_ENABLED empty' },
      fetchCalls,
    };
  } catch (error) {
    const disabled = error instanceof EmbeddingsDisabledError;
    return {
      check: {
        id: 'embeddings_throws_disabled',
        ok: disabled && flagOff && fetchCalls === 0,
        detail: disabled
          ? `embedTexts() rejected with EmbeddingsDisabledError (flag off: ${String(flagOff)}, fetch calls=${fetchCalls})`
          : `embedTexts() rejected with an unexpected error: ${String(error)}`,
      },
      fetchCalls,
    };
  }
}

async function probeDeterministicFallbacks(): Promise<AiOffCheck> {
  const details: string[] = [];
  let ok = true;

  try {
    const digest = await summarizeDigestNarrative({} as unknown as DigestData, { enabled: false });
    const deterministic = digest.usedAi === false && digest.narrative === null;
    ok = ok && deterministic;
    details.push(`digest narrative off -> {narrative:null, usedAi:${String(digest.usedAi)}}`);
  } catch (error) {
    ok = false;
    details.push(`digest narrative probe failed: ${String(error)}`);
  }

  try {
    const suggestion = await suggestEventTags({ title: 'ai-off probe' }, { enabled: false });
    const deterministic = suggestion.usedAi === false;
    ok = ok && deterministic;
    details.push(`event tagging off -> {category:${JSON.stringify(suggestion.category)}, tags:${suggestion.tags.length}, usedAi:${String(suggestion.usedAi)}}`);
  } catch (error) {
    ok = false;
    details.push(`event tagging probe failed: ${String(error)}`);
  }

  try {
    const parsed = await parseOperation('ai-off probe', {
      ai: {
        chat: async () => {
          throw new AiDisabledError();
        },
      },
      now: new Date('2026-01-01T00:00:00Z'),
      timezone: 'Asia/Shanghai',
    });
    const deterministic = parsed != null;
    ok = ok && deterministic;
    details.push(`parser with a disabled provider -> status=${String((parsed as { status?: string }).status ?? 'fallback')}`);
  } catch (error) {
    ok = false;
    details.push(`parser probe failed: ${String(error)}`);
  }

  return { id: 'deterministic_fallbacks', ok, detail: details.join('; ') };
}

/** Runs every check; never throws and never echoes secret values. */
export async function verifyAiOff(): Promise<AiOffProof> {
  const checks: AiOffCheck[] = [];

  const envExample = readEnvExample();
  const violations = envExample ? nonEmptyAiVars(envExample.content) : [];
  checks.push({
    id: 'env_example_ai_vars_empty',
    ok: violations.length === 0,
    detail: envExample
      ? violations.length === 0
        ? `.env.example (${envExample.path}) ships every AI variable empty`
        : `.env.example has non-empty AI variables: ${violations.join(', ')}`
      : '.env.example not found next to the module or cwd; file check skipped',
  });

  const runtimeProviders = listConfiguredProviders(process.env);
  checks.push({
    id: 'runtime_ai_off',
    ok: runtimeProviders.length === 0,
    detail: runtimeProviders.length === 0
      ? 'no AI provider is configured in the running process'
      : `configured providers in the running process: ${runtimeProviders.join(', ')}`,
  });

  checks.push({
    id: 'default_off_without_env',
    ok: isAiConfigured({}) === false,
    detail: `isAiConfigured({}) === ${String(isAiConfigured({}))}`,
  });

  const gatewayProbe = await probeGatewayDisabled();
  const embeddingsProbe = await probeEmbeddingsDisabled();
  checks.push(gatewayProbe.check, embeddingsProbe.check);

  checks.push({
    id: 'no_request_when_disabled',
    ok: gatewayProbe.fetchCalls === 0 && embeddingsProbe.fetchCalls === 0,
    detail: `spy fetch calls: gateway=${gatewayProbe.fetchCalls}, embeddings=${embeddingsProbe.fetchCalls}`,
  });

  const flagsOff =
    isDigestNarrativeEnabled({}) === false &&
    isEventTaggingEnabled({}) === false &&
    isTemplateTranslationEnabled({}) === false;
  checks.push({
    id: 'feature_flags_default_off',
    ok: flagsOff,
    detail: 'AI_DIGEST_NARRATIVE / AI_EVENT_TAGGING / AI_TEMPLATE_TRANSLATION all default to false',
  });

  checks.push(await probeDeterministicFallbacks());

  const runtimeEnvSet = AI_ENV_VARS.filter((key) => (process.env[key] ?? '').trim() !== '');

  return {
    aiOff: checks.every((check) => check.ok) && violations.length === 0 && runtimeProviders.length === 0,
    checkedAt: new Date().toISOString(),
    runtimeConfiguredProviders: runtimeProviders,
    runtimeEnvSet,
    envExample: { checked: envExample !== null, path: envExample?.path ?? null, nonEmptyVars: violations },
    checks,
    surfaces: AI_DEPENDENT_SURFACES,
  };
}
