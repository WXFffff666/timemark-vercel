/**
 * Opt-in summarisation, tagging and translation (checkbox 108).
 *
 * THREE features, EACH OFF BY DEFAULT and enabled only by an explicit env flag:
 *
 *   AI_DIGEST_NARRATIVE=true     - a one-paragraph narrative for the monthly digest (79)
 *   AI_EVENT_TAGGING=true        - a category/tag SUGGESTION for an event (never applied)
 *   AI_TEMPLATE_TRANSLATION=true - translate a preset template into another language
 *
 * DEGRADATION IS SILENT. AI disabled, provider error, timeout, a malformed answer or a
 * failed hallucination guard all return the deterministic result (`null` narrative /
 * empty suggestion / `null` translation) and NEVER throw to the caller. The gateway
 * (`./gateway.js`, checkbox 98) supplies the typed errors, `AbortController` timeout, the
 * one full-jitter retry, failover and the bounded sha256-keyed cache; this module only
 * assembles prompts, validates answers and reuses that cache (it never opts out).
 *
 * HALLUCINATION GUARD (the core of this task). Before an answer is used, every maximal
 * digit-run in the model text must also appear as a substring of the prompt the model was
 * given (`numeralsGrounded`). Facts are computed deterministically and are the ONLY numbers
 * placed in the prompt, so the model never has to - and is never allowed to - invent one.
 * A single unmatched numeral discards the whole answer and falls back to the deterministic
 * output (task 79's unchanged digest / the empty suggestion / no translation).
 *
 * Like `parse.ts` (99), the provider is injected (`SummarizerAi`) so tests never perform a
 * real request. This module does NOT modify `gateway.ts`, `routes/ai.ts` or `parse.ts`.
 *
 * Types are intentionally backend-local (task 100 owns the shared barrel this batch).
 */

import { PRESET_TEMPLATES, templatePlaceholders } from '@timemark/shared/templates';
import { createLogger } from '../../utils/logger.js';
import type { DigestData } from '../digest.service.js';
import { fenceUntrusted } from '../bot/fencing.js';
import {
  chat as gatewayChat,
  type AiChatOptions,
  type AiChatResult,
  type AiMessage,
} from './gateway.js';

const log = createLogger('ai-summarize');

// ---------------------------------------------------------------------------
// Provider seam + opt-in flags
// ---------------------------------------------------------------------------

/** Minimal gateway surface this module needs; injected so tests never hit a provider. */
export interface SummarizerAi {
  chat(messages: AiMessage[], options?: AiChatOptions): Promise<AiChatResult>;
}

/** Production wiring: the shared gateway singleton from checkbox 98 (cache included). */
export const defaultSummarizerAi: SummarizerAi = { chat: gatewayChat };

/** Same opt-in convention as `embeddings.ts`: only the exact string `true` enables a flag. */
function envFlag(env: Record<string, string | undefined>, name: string): boolean {
  return String(env[name] ?? '').trim().toLowerCase() === 'true';
}

export function isDigestNarrativeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envFlag(env, 'AI_DIGEST_NARRATIVE');
}

export function isEventTaggingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envFlag(env, 'AI_EVENT_TAGGING');
}

export function isTemplateTranslationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envFlag(env, 'AI_TEMPLATE_TRANSLATION');
}

/** Options shared by the three features. `enabled` defaults to false (never opt-in by accident). */
export interface SummarizeOptions {
  enabled?: boolean;
  ai?: SummarizerAi;
}

// ---------------------------------------------------------------------------
// Numeral grounding guard (the hallucination control)
// ---------------------------------------------------------------------------

const FULL_WIDTH_DIGITS = /[０-９]/g;

/**
 * Normalise a string before numeral extraction:
 *  - full-width digits `０-９` -> ASCII `0-9`;
 *  - a thousands separator between two digits is removed (`1,234` and `1234` compare
 *    equal). The separator replacement is iterated so `1,234,567` collapses fully.
 */
function normalizeNumerals(text: string): string {
  let out = text.replace(FULL_WIDTH_DIGITS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  let previous: string;
  do {
    previous = out;
    out = out.replace(/(\d)[,，](\d)/g, '$1$2');
  } while (out !== previous);
  return out;
}

/** Every maximal ASCII digit-run, e.g. `2026-12-05` -> `['2026','12','05']`. */
export function extractNumerals(text: string): string[] {
  return normalizeNumerals(text).match(/\d+/g) ?? [];
}

/**
 * HALLUCINATION GUARD. The answer is grounded iff EVERY maximal digit-run in the model
 * text also appears as a substring of the prompt. Consequences, spelled out because the
 * rule is load-bearing:
 *  - `12` inside `2026-12-05` is the run `12` (the year `2026` and day `05` are separate
 *    runs); when the prompt contains `2026-12-05` all three are present -> accepted;
 *  - a total the prompt never contained (`999`) has no matching run -> the whole answer
 *    is rejected;
 *  - the guard is one-directional on purpose: it proves "no invented numerals", not
 *    "every prompt numeral was used".
 */
export function numeralsGrounded(output: string, prompt: string): boolean {
  const haystack = normalizeNumerals(prompt);
  return extractNumerals(output).every((numeral) => haystack.includes(numeral));
}

/** All three prompts wrap the untrusted/model-facing data block in `fenceUntrusted` (96). */
function buildUserPrompt(instruction: string, dataBlock: string): string {
  return `${instruction}\n${fenceUntrusted(dataBlock)}`;
}

// ---------------------------------------------------------------------------
// (a) Digest narrative
// ---------------------------------------------------------------------------

const DIGEST_NARRATIVE_SYSTEM =
  'You are a concise personal time-management assistant. You write ONLY from the data supplied in the user message.';

// Deliberately free of ASCII digits: any digit here would widen the grounding guard.
const DIGEST_NARRATIVE_INSTRUCTION = [
  '请根据下面的统计数据，用一段中文总结本期的要点。',
  '只能使用这些数字，不得新增、推算或修改任何数字或事实。',
  '只输出这一段话，不要标题、列表或 markdown。',
].join('\n');

/** One computed fact per digest section. The value is the ONLY number the prompt carries. */
export interface DigestFact {
  key: string;
  label: string;
  value: number;
}

/**
 * The deterministic facts: straight from the already-computed `DigestData` counts. The
 * model narrates these; it never recomputes anything (the digest SQL already did the math).
 */
export function digestFacts(data: DigestData): DigestFact[] {
  return [
    { key: 'upcoming', label: '未来 30 天事项', value: data.upcoming.length },
    { key: 'overdue', label: '逾期事项', value: data.overdue.length },
    { key: 'once_spend', label: '一次性支出笔数', value: data.spend.onceCount },
    { key: 'habits', label: '习惯', value: data.habits.length },
    { key: 'medications', label: '用药记录条数', value: data.medications.total },
    { key: 'maintenance', label: '保养到期', value: data.maintenance.length },
    { key: 'goals', label: '目标', value: data.goals.length },
  ];
}

function digestFactsText(data: DigestData, facts: DigestFact[]): string {
  return [`统计区间：${data.from} 至 ${data.to}`, ...facts.map((fact) => `${fact.label}：${fact.value}`)].join('\n');
}

const NARRATIVE_MAX_CHARS = 600;

function normalizeNarrative(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > NARRATIVE_MAX_CHARS ? `${text.slice(0, NARRATIVE_MAX_CHARS - 1)}…` : text;
}

export interface DigestNarrativeResult {
  narrative: string | null;
  usedAi: boolean;
}

/**
 * (a) One-paragraph digest narrative from the computed counts. Returns `narrative: null`
 * whenever the feature is off, the provider fails, or the answer invents a numeral - the
 * caller then renders the unchanged deterministic digest.
 */
export async function summarizeDigestNarrative(
  data: DigestData,
  options: SummarizeOptions = {},
): Promise<DigestNarrativeResult> {
  if (!options.enabled) return { narrative: null, usedAi: false };
  const ai = options.ai ?? defaultSummarizerAi;
  const prompt = buildUserPrompt(DIGEST_NARRATIVE_INSTRUCTION, digestFactsText(data, digestFacts(data)));
  try {
    const result = await ai.chat(
      [
        { role: 'system', content: DIGEST_NARRATIVE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 512 },
    );
    const narrative = normalizeNarrative(String(result.content ?? ''));
    if (!narrative) return { narrative: null, usedAi: false };
    if (!numeralsGrounded(narrative, prompt)) {
      log.warn({ event: 'ai.summarize.narrative_rejected' }, 'Digest narrative rejected: a numeral is absent from the prompt');
      return { narrative: null, usedAi: false };
    }
    return { narrative, usedAi: true };
  } catch (error) {
    log.warn({ event: 'ai.summarize.narrative_failed', err: error }, 'Digest narrative unavailable; using the deterministic digest');
    return { narrative: null, usedAi: false };
  }
}

// ---------------------------------------------------------------------------
// (b) Event auto-tagging (suggestion only - never applied)
// ---------------------------------------------------------------------------

const TAGGING_SYSTEM =
  'You classify personal calendar events. Answer ONLY with the requested JSON object.';

const TAGGING_INSTRUCTION = [
  '根据事件标题与备注，从分类中选一个分类并给出若干标签。',
  '只输出 JSON：{"category": string|null, "tags": string[]}。',
  '不得新增数字或事实；没有合适分类时 category 用 null。',
].join('\n');

const TAG_SUGGESTION_JSON_SCHEMA: Record<string, unknown> = {
  name: 'event_tag_suggestion',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'tags'],
    properties: {
      category: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
};

export interface EventTagInput {
  title: string;
  notes?: string | null;
}

export interface TagSuggestion {
  category: string | null;
  tags: string[];
  /**
   * ALWAYS false: this module only ever produces a SUGGESTION. Applying it is a separate,
   * user-confirmed action elsewhere - `suggestEventTags` never writes to the event.
   */
  accepted: false;
  usedAi: boolean;
}

function emptySuggestion(): TagSuggestion {
  return { category: null, tags: [], accepted: false, usedAi: false };
}

/** Parse the first `{...}` object out of a raw model answer (tolerates ```json fences). */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null; // malformed answer -> caller keeps the empty suggestion
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * (b) Suggest a category/tags for an event. The result is a suggestion with
 * `accepted: false`; nothing is written. Off by default; any failure yields the empty
 * suggestion with `accepted: false`.
 */
export async function suggestEventTags(
  input: EventTagInput,
  options: SummarizeOptions = {},
): Promise<TagSuggestion> {
  if (!options.enabled) return emptySuggestion();
  const ai = options.ai ?? defaultSummarizerAi;
  const dataText = [`标题：${input.title ?? ''}`, `备注：${input.notes ?? ''}`].join('\n');
  const prompt = buildUserPrompt(TAGGING_INSTRUCTION, dataText);
  try {
    const result = await ai.chat(
      [
        { role: 'system', content: TAGGING_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 256, jsonSchema: TAG_SUGGESTION_JSON_SCHEMA },
    );
    const raw = String(result.content ?? '');
    if (!numeralsGrounded(raw, prompt)) {
      log.warn({ event: 'ai.summarize.tags_rejected' }, 'Tag suggestion rejected: a numeral is absent from the prompt');
      return emptySuggestion();
    }
    const parsed = parseJsonObject(raw);
    if (!parsed) return emptySuggestion();
    const category =
      typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category.trim().slice(0, 60) : null;
    const tags = Array.isArray(parsed.tags)
      ? [
          ...new Set(
            parsed.tags
              .filter((tag): tag is string => typeof tag === 'string')
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ].slice(0, 8)
      : [];
    return { category, tags, accepted: false, usedAi: true };
  } catch (error) {
    log.warn({ event: 'ai.summarize.tags_failed', err: error }, 'Event tagging unavailable; returning no suggestion');
    return emptySuggestion();
  }
}

// ---------------------------------------------------------------------------
// (c) Template translation
// ---------------------------------------------------------------------------

const TRANSLATION_SYSTEM = 'You translate notification templates. Preserve every {{placeholder}} verbatim.';

function translationInstruction(language: string): string {
  return [
    `把下面的通知模板翻译成${language}。`,
    '必须原样保留所有 {{...}} 占位符，不得增删占位符，也不得新增数字或事实。',
    '只输出翻译后的模板正文。',
  ].join('\n');
}

export interface TemplateTranslationResult {
  content: string | null;
  language: string;
  usedAi: boolean;
}

/**
 * (c) Translate a template body into another language on demand. Rejected when the
 * placeholder set changes (a dropped/invented `{{var}}`) or a numeral appears that the
 * source did not contain; off/error/malformed -> `content: null`.
 */
export async function translateTemplate(
  template: { id: string; content: string; variables?: string[] },
  targetLanguage: string,
  options: SummarizeOptions = {},
): Promise<TemplateTranslationResult> {
  const language = String(targetLanguage ?? '').trim();
  if (!options.enabled || !language) return { content: null, language, usedAi: false };
  const ai = options.ai ?? defaultSummarizerAi;
  const prompt = buildUserPrompt(translationInstruction(language), template.content);
  const required = templatePlaceholders(template.content);
  try {
    const result = await ai.chat(
      [
        { role: 'system', content: TRANSLATION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 512 },
    );
    const translated = String(result.content ?? '').trim();
    if (!translated) return { content: null, language, usedAi: false };
    if (!numeralsGrounded(translated, prompt)) {
      log.warn({ event: 'ai.summarize.translation_rejected', reason: 'numeral' }, 'Template translation rejected: a numeral is absent from the source');
      return { content: null, language, usedAi: false };
    }
    const produced = templatePlaceholders(translated);
    const missing = required.some((name) => !produced.includes(name));
    if (missing || produced.length !== required.length) {
      log.warn({ event: 'ai.summarize.translation_rejected', reason: 'placeholder' }, 'Template translation rejected: placeholders changed');
      return { content: null, language, usedAi: false };
    }
    return { content: translated, language, usedAi: true };
  } catch (error) {
    log.warn({ event: 'ai.summarize.translation_failed', err: error }, 'Template translation unavailable');
    return { content: null, language, usedAi: false };
  }
}

/**
 * (c) Convenience wrapper over a shared preset: looks the preset up in the shared
 * `PRESET_TEMPLATES` and translates its body. Unknown id -> no translation.
 */
export async function translatePresetTemplate(
  presetId: string,
  targetLanguage: string,
  options: SummarizeOptions = {},
): Promise<TemplateTranslationResult> {
  const preset = PRESET_TEMPLATES.find((template) => template.id === presetId);
  if (!preset) return { content: null, language: String(targetLanguage ?? '').trim(), usedAi: false };
  return translateTemplate({ id: preset.id, content: preset.content, variables: preset.variables }, targetLanguage, options);
}
