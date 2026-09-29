/**
 * Natural-language → validated operation parser (checkbox 99).
 *
 * Turns one Chinese/English utterance into a schema-validated operation (see
 * `@timemark/shared/nl-fallback`), then - only for a confident, complete operation -
 * executes it through an injectable seam.
 *
 * FOUR-LAYER DEGRADATION (never hard-fails; plan criterion 14: AI ships OFF):
 *
 *   1. primary   - function calling (`tools`), OpenAI-compatible `tool_calls`
 *   2. fallback  - JSON-schema prompt (`response_format: json_schema`)
 *   3. regex     - `parseWithRegex` from `@timemark/shared/nl-fallback`
 *   4. clarify   - a clarifying question (NEVER a guess)
 *
 * Every AI answer is validated with Zod BEFORE anything runs. A validation failure is
 * retried exactly ONCE with the validation error appended to the conversation, then the
 * parser degrades to the next layer. A layer that returns a schema-valid but `unknown`,
 * ambiguous (missing required date), or below-threshold operation stops the funnel and
 * asks - the regex layer must not "upgrade" an incomplete answer into a wrong date.
 *
 * Untrusted text is always fenced with `fenceUntrusted` (checkbox 96) so message content
 * is presented to the model as DATA, never as instructions.
 *
 * The provider surface is injected (`ParserAi`) so tests never perform a real request.
 * This module does NOT modify `gateway.ts` (task 107 owns it) - it only consumes `chat()`.
 */

import { formatZodError } from '@timemark/shared';
import { dateStringInTimeZone } from '@timemark/shared/habit-schedule';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  OPERATION_KINDS,
  parseWithRegex,
  parsedOperationSchema,
  type CreateEventOperation,
  type CompleteTodoOperation,
  type NlParseContext,
  type ParsedOperation,
} from '@timemark/shared/nl-fallback';
import { fenceUntrusted } from '../bot/fencing.js';
import {
  AiError,
  chat as gatewayChat,
  type AiChatOptions,
  type AiChatResult,
  type AiMessage,
} from './gateway.js';
import { query } from '../../db/index.js';
import { createEvent } from '../event.service.js';
import { markTodoComplete } from '../todo.service.js';
import { lunarConverter } from '../../utils/lunar-converter.js';

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

/** Minimal gateway surface the parser needs; injected so tests never hit a provider. */
export interface ParserAi {
  chat(messages: AiMessage[], options?: AiChatOptions): Promise<AiChatResult>;
}

/** Production wiring: the shared gateway singleton from checkbox 98. */
export const defaultParserAi: ParserAi = { chat: gatewayChat };

// ---------------------------------------------------------------------------
// Prompt + JSON schema (shared by the tool definition and the json_schema prompt)
// ---------------------------------------------------------------------------

/**
 * Hand-written JSON Schema for the operation union. It is intentionally kept next to the
 * Zod schema in `@timemark/shared/nl-fallback`: the JSON Schema is what the provider sees,
 * the Zod schema is what validates the answer locally (no `zod-to-json-schema` dependency).
 */
export const OPERATION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'confidence'],
  properties: {
    kind: { type: 'string', enum: [...OPERATION_KINDS] },
    title: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: '公历日期 YYYY-MM-DD' },
    lunar: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['month', 'day'],
      properties: {
        month: { type: 'integer', minimum: 1, maximum: 12 },
        day: { type: 'integer', minimum: 1, maximum: 30 },
        isLeap: { type: 'boolean' },
      },
    },
    recurrence: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['frequency'],
      properties: {
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        interval: { type: 'integer', minimum: 1 },
      },
    },
    leadDays: { type: ['integer', 'null'], minimum: 0 },
    channels: { type: 'array', items: { type: 'string' } },
    contactName: { type: ['string', 'null'] },
    todoId: { type: ['integer', 'null'] },
    amount: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    query: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

/** `response_format: { type:'json_schema', json_schema: <this> }` (layer 2). */
export const OPERATION_RESPONSE_FORMAT: Record<string, unknown> = {
  name: 'timemark_operation',
  strict: true,
  schema: OPERATION_JSON_SCHEMA,
};

/** Function-calling tool definition (layer 1). */
export const OPERATION_TOOL: Record<string, unknown> = {
  type: 'function',
  function: {
    name: 'record_operation',
    description:
      'Record exactly one structured TimeMark operation parsed from the user message. ' +
      'Resolve relative dates against the current time given in the prompt.',
    parameters: OPERATION_JSON_SCHEMA,
  },
};

export const OPERATION_PARSER_SYSTEM_PROMPT = [
  '你是 TimeMark 的自然语言解析器。把用户输入解析成 ONE 个 JSON 操作。',
  `kind 必须是其一：${OPERATION_KINDS.join(' / ')}。`,
  '规则：',
  '- 无法确定意图时返回 kind="unknown"，并给出 reason；绝不猜测日期。',
  '- date 使用公历 YYYY-MM-DD；农历日期写入 lunar{month,day,isLeap} 且 date=null。',
  '- 相对日期（明天/下周三/in 3 days）必须结合提示中的当前时间和时区换算成 YYYY-MM-DD。',
  '- confidence 为 0..1 的数字；不确定时给较低值。',
  '- 只输出操作本身，不输出解释。',
].join('\n');

// ---------------------------------------------------------------------------
// Parse outcome
// ---------------------------------------------------------------------------

export type ParseLayer = 'primary' | 'fallback' | 'regex';

export type ClarifyReason =
  | 'ai_unavailable'
  | 'unknown'
  | 'low_confidence'
  | 'ambiguous'
  | 'no_match'
  | 'invalid_output';

export interface ParseOk {
  status: 'ok';
  operation: ParsedOperation;
  layer: ParseLayer;
}

export interface ParseAsk {
  status: 'clarify';
  question: string;
  reason: ClarifyReason;
  layer: 'clarify';
}

export type ParseOutcome = ParseOk | ParseAsk;

export interface ParseOperationDeps {
  ai?: ParserAi;
  /** Reference instant; defaults to the wall clock. */
  now?: Date;
  timezone?: string;
  confidenceThreshold?: number;
}

const CLARIFY_QUESTIONS: Record<ClarifyReason, string> = {
  ai_unavailable: '我暂时无法理解这句话。请补充事项和日期，例如：买牛奶 @ 2026-10-01 09:00。',
  unknown: '抱歉，我没听懂这句话。请说得更明确一些，例如：买牛奶 @ 2026-10-01。',
  low_confidence: '我不太确定你的意思。请确认事项，并补充具体日期。',
  ambiguous: '这个日期还不够具体：请补充到「月+日」，例如：下个月15日续费会员。',
  no_match: '请补充事项和日期，例如：买牛奶 @ 2026-10-01。',
  invalid_output: '我暂时无法可靠地解析这句话。请换一种说法，或补充明确的日期。',
};

export function buildClarifyingQuestion(reason: ClarifyReason): string {
  return CLARIFY_QUESTIONS[reason];
}

/**
 * A non-`unknown`, confident, complete operation may be executed. `create_event` needs a
 * resolvable date (or a lunar spec); `create_expiry` needs a concrete date; `complete_todo`
 * needs an id or a title.
 */
export function isExecutable(
  op: ParsedOperation,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): boolean {
  if (op.kind === 'unknown') return false;
  if (op.confidence < threshold) return false;
  if (op.kind === 'create_event') return op.date !== null || op.lunar !== null;
  if (op.kind === 'create_expiry') return op.date !== null;
  if (op.kind === 'complete_todo') return op.todoId !== null || op.title !== null;
  return true;
}

// ---------------------------------------------------------------------------
// Layer 1 + 2: AI parsing with one validation-repair retry
// ---------------------------------------------------------------------------

function buildUserMessage(input: string, ctx: NlParseContext): string {
  const today = dateStringInTimeZone(ctx.now, ctx.timezone);
  return [
    `当前时间：${ctx.now.toISOString()}（时区 ${ctx.timezone}，今天 ${today}）`,
    '请把下面的用户输入解析为一个操作：',
    fenceUntrusted(input),
  ].join('\n');
}

/** Strip a Markdown code fence some providers wrap JSON in. */
function stripCodeFence(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (match ? match[1] : text).trim();
}

function extractRaw(result: AiChatResult, mode: 'tools' | 'json_schema'): unknown {
  if (mode === 'tools') {
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    const first = calls[0] as { function?: { arguments?: unknown } } | undefined;
    const args = first?.function?.arguments;
    if (typeof args === 'string') return args;
    if (args !== null && typeof args === 'object') return args;
    return null;
  }
  return typeof result.content === 'string' && result.content.trim() ? result.content : null;
}

interface ValidatedRaw {
  op: ParsedOperation | null;
  error: string | null;
}

function validateRaw(raw: unknown): ValidatedRaw {
  if (raw === null || raw === undefined) return { op: null, error: null };
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(stripCodeFence(raw));
    } catch {
      return { op: null, error: '输出不是合法 JSON' };
    }
  }
  const parsed = parsedOperationSchema.safeParse(candidate);
  if (!parsed.success) return { op: null, error: formatZodError(parsed.error) };
  return { op: parsed.data, error: null };
}

/**
 * One AI layer: call, validate, and on a validation failure retry ONCE with the error
 * appended. Returns the validated op, or `null` when the layer produced nothing usable.
 * Provider errors propagate as typed `AiError` so the caller can classify them.
 */
async function parseViaAi(
  input: string,
  ctx: NlParseContext,
  ai: ParserAi,
  mode: 'tools' | 'json_schema',
): Promise<ParsedOperation | null> {
  const messages: AiMessage[] = [
    { role: 'system', content: OPERATION_PARSER_SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(input, ctx) },
  ];
  const options: AiChatOptions =
    mode === 'tools'
      ? { tools: [OPERATION_TOOL], useCache: false }
      : { jsonSchema: OPERATION_RESPONSE_FORMAT, useCache: false };

  const first = validateRaw(extractRaw(await ai.chat(messages, options), mode));
  if (first.op) return first.op;
  if (first.error === null) return null; // provider produced no candidate at all

  const repair = validateRaw(
    extractRaw(
      await ai.chat(
        [
          ...messages,
          { role: 'assistant', content: '（上一次输出未通过校验）' },
          { role: 'user', content: `上一次输出无效：${first.error}。请修正后只输出符合 schema 的 JSON。` },
        ],
        options,
      ),
      mode,
    ),
  );
  return repair.op;
}

// ---------------------------------------------------------------------------
// Public parse entry point
// ---------------------------------------------------------------------------

/**
 * Parse one utterance into a validated operation, degrading primary → fallback → regex →
 * clarifying question. Never throws for provider/validation problems.
 */
export async function parseOperation(
  input: string,
  deps: ParseOperationDeps = {},
): Promise<ParseOutcome> {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) {
    return { status: 'clarify', layer: 'clarify', reason: 'no_match', question: CLARIFY_QUESTIONS.no_match };
  }

  const threshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const ctx: NlParseContext = {
    now: deps.now ?? new Date(),
    timezone: deps.timezone ?? 'Asia/Shanghai',
  };
  const ai = deps.ai ?? defaultParserAi;
  let degraded: ClarifyReason = 'ai_unavailable';

  for (const mode of ['tools', 'json_schema'] as const) {
    let op: ParsedOperation | null;
    try {
      op = await parseViaAi(text, ctx, ai, mode);
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      degraded = error.code === 'AI_DISABLED' ? 'ai_unavailable' : 'invalid_output';
      continue;
    }
    if (!op) {
      degraded = 'invalid_output';
      continue;
    }
    if (op.kind === 'unknown') {
      degraded = 'unknown';
      continue;
    }
    if (!isExecutable(op, threshold)) {
      // The model understood the intent but the operation is incomplete/uncertain: ask
      // instead of letting the regex layer guess a date.
      const reason: ClarifyReason = op.confidence < threshold ? 'low_confidence' : 'ambiguous';
      return { status: 'clarify', layer: 'clarify', reason, question: buildClarifyingQuestion(reason) };
    }
    return { status: 'ok', operation: op, layer: mode === 'tools' ? 'primary' : 'fallback' };
  }

  const fallbackOp = parseWithRegex(text, ctx);
  if (fallbackOp && isExecutable(fallbackOp, threshold)) {
    return { status: 'ok', operation: fallbackOp, layer: 'regex' };
  }

  return { status: 'clarify', layer: 'clarify', reason: degraded, question: buildClarifyingQuestion(degraded) };
}

// ---------------------------------------------------------------------------
// Execution seam (ownership is enforced here; task 108 refines the remaining kinds)
// ---------------------------------------------------------------------------

export type ExecutionResult =
  | { status: 'executed'; kind: ParsedOperation['kind']; entityId: number | null }
  | { status: 'rejected'; kind: ParsedOperation['kind']; httpStatus: 404; reason: string }
  | { status: 'not_supported'; kind: ParsedOperation['kind']; reason: string }
  | { status: 'clarify'; reason: ClarifyReason; question: string };

export interface OperationExecutor {
  createEvent(userId: number, op: CreateEventOperation, ctx: NlParseContext): Promise<{ eventId: number }>;
  completeTodo(
    userId: number,
    op: CompleteTodoOperation,
    ctx: NlParseContext,
  ): Promise<{ eventId: number } | { notFound: true }>;
}

export interface ExecuteOperationDeps {
  userId: number;
  executor?: OperationExecutor;
  now?: Date;
  timezone?: string;
  confidenceThreshold?: number;
}

/** Resolve a lunar spec to a Gregorian YYYY-MM-DD using the solar year as the lunar year
 * (the same convention `lunar-holidays.ts` uses for a year-less lunar event). */
function lunarSpecToYmd(lunar: CreateEventOperation['lunar'], ctx: NlParseContext): string | null {
  if (!lunar) return null;
  const year = Number(dateStringInTimeZone(ctx.now, ctx.timezone).slice(0, 4));
  return lunarConverter.lunarToGregorian({
    year,
    month: lunar.month,
    day: lunar.day,
    isLeap: lunar.isLeap,
  });
}

/** Production executor: real services, every read scoped by `user_id`. */
export const defaultOperationExecutor: OperationExecutor = {
  async createEvent(userId, op, ctx) {
    const date = op.date ?? lunarSpecToYmd(op.lunar, ctx);
    if (!date) throw new Error('create_event requires a resolvable date');
    const lunarYear = op.lunar ? Number(dateStringInTimeZone(ctx.now, ctx.timezone).slice(0, 4)) : null;
    const event = await createEvent(String(userId), {
      name: op.title,
      type: 'other',
      date,
      calendarType: op.lunar ? 'lunar' : 'gregorian',
      ...(op.lunar && lunarYear !== null
        ? { lunarDate: { year: lunarYear, month: op.lunar.month, day: op.lunar.day, isLeap: op.lunar.isLeap } }
        : {}),
      reminderConfig: {
        enabled: true,
        daysBeforeList: op.leadDays !== null ? [op.leadDays] : [1, 3, 7],
        emailRecipients: [],
        channels: op.channels,
        accountIds: [],
      },
      ...(op.recurrence
        ? {
            recurringConfig: {
              enabled: true,
              frequency: op.recurrence.frequency,
              interval: op.recurrence.interval,
              endType: 'never' as const,
            },
          }
        : {}),
    });
    return { eventId: Number(event.id) };
  },

  async completeTodo(userId, op) {
    // Ownership is enforced by the WHERE clause; a foreign/deleted id yields no row and
    // therefore a 404 (never a silent success - defect D2).
    if (op.todoId !== null) {
      const owned = await query(
        `SELECT id, date::text AS date FROM events WHERE id = $1 AND user_id = $2`,
        [op.todoId, userId],
      );
      const row = owned.rows[0] as { id: number; date: string } | undefined;
      if (!row) return { notFound: true };
      await markTodoComplete(userId, Number(row.id), op.date ?? String(row.date).slice(0, 10));
      return { eventId: Number(row.id) };
    }
    const byTitle = await query(
      `SELECT id, date::text AS date FROM events
        WHERE user_id = $1 AND name = $2 AND NOT EXISTS (
          SELECT 1 FROM todo_completions tc
          WHERE tc.user_id = events.user_id AND tc.event_id = events.id
            AND tc.occurrence_date = events.date::date
        )
        ORDER BY date ASC, id ASC LIMIT 1`,
      [userId, op.title],
    );
    const row = byTitle.rows[0] as { id: number; date: string } | undefined;
    if (!row) return { notFound: true };
    await markTodoComplete(userId, Number(row.id), op.date ?? String(row.date).slice(0, 10));
    return { eventId: Number(row.id) };
  },
};

/**
 * Execute a validated operation. `unknown` and below-threshold/incomplete operations are
 * NEVER executed - they ask instead. An operation that targets a missing or foreign entity
 * is rejected with HTTP 404.
 */
export async function executeOperation(
  op: ParsedOperation,
  deps: ExecuteOperationDeps,
): Promise<ExecutionResult> {
  const threshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (!isExecutable(op, threshold)) {
    const reason: ClarifyReason = op.kind === 'unknown' ? 'unknown' : op.confidence < threshold ? 'low_confidence' : 'ambiguous';
    return { status: 'clarify', reason, question: buildClarifyingQuestion(reason) };
  }

  const executor = deps.executor ?? defaultOperationExecutor;
  const ctx: NlParseContext = {
    now: deps.now ?? new Date(),
    timezone: deps.timezone ?? 'Asia/Shanghai',
  };

  switch (op.kind) {
    case 'create_event': {
      const { eventId } = await executor.createEvent(deps.userId, op, ctx);
      return { status: 'executed', kind: op.kind, entityId: eventId };
    }
    case 'complete_todo': {
      const result = await executor.completeTodo(deps.userId, op, ctx);
      if ('notFound' in result) {
        return {
          status: 'rejected',
          kind: op.kind,
          httpStatus: 404,
          reason: '事项不存在或不属于当前用户',
        };
      }
      return { status: 'executed', kind: op.kind, entityId: result.eventId };
    }
    default:
      return {
        status: 'not_supported',
        kind: op.kind,
        reason: '该操作类型由后续任务（100/108）执行',
      };
  }
}
