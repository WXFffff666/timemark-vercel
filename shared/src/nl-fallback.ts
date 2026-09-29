/**
 * Deterministic NL → structured-operation contract + regex fallback (checkbox 99).
 *
 * This module owns the canonical operation contract consumed by the AI parser
 * (`backend/src/services/ai/parse.ts`) and by tasks 100/102/108/109:
 *
 *   - `parsedOperationSchema` is the single source of truth (Zod discriminated union on
 *     `kind`), so the TypeScript types and the runtime validation can never drift.
 *   - `parseWithRegex` is the THIRD degradation layer of the parser. It runs only when the
 *     AI provider is disabled/unavailable or returned no schema-valid operation.
 *
 * The grammar is deliberately conservative and covers ONLY the simplest utterances:
 *
 *   `标题 @ 8月15日`    -> create_event (title + gregorian date)
 *   `开会 in 3 days`     -> create_event (title + relative date)
 *   `开会 每周一`        -> create_event (title + weekly recurrence + next Monday)
 *   `明天买菜`           -> create_event (title + relative date)
 *   `2026-10-05 交报告`  -> create_event (title + ISO date)
 *
 * Any utterance that signals a richer intent the grammar cannot express faithfully
 * (lunar dates, lead-days, expiry/renewal, medication, contact interactions, todo
 * completion, free-form queries) carries a MODALITY marker (`农历`, `提前`, `续费`, `药`,
 * `记一下`, `完成`, `查`, ...) and `parseWithRegex` returns `null`. The caller then degrades
 * to a clarifying question instead of inventing a wrong date - "ask, never guess".
 *
 * Pure and dependency-free beyond Zod: it reads NO clock and performs NO network call
 * (`now`/`timezone` are injected by the caller).
 */

import { z } from 'zod';
import { dateStringInTimeZone, shiftCalendarDays } from './habit-schedule.js';

export const OPERATION_KINDS = [
  'create_event',
  'create_expiry',
  'log_interaction',
  'complete_todo',
  'log_dose',
  'log_habit',
  'query',
  'unknown',
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/** Ops at or above this confidence may be executed; lower ones ask instead. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

const lunarSchema = z.object({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(30),
  isLeap: z.boolean().default(false),
});

const recurrenceSchema = z.object({
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).default(1),
});

const dateField = ymdSchema.nullable().default(null);
const lunarField = lunarSchema.nullable().default(null);
const recurrenceField = recurrenceSchema.nullable().default(null);
const leadDaysField = z.number().int().min(0).max(3650).nullable().default(null);
const channelsField = z.array(z.string().min(1).max(60)).max(50).default([]);
const confidenceField = z.number().min(0).max(1);

/**
 * The one operation contract. Every variant carries a `confidence` in [0, 1]; optional
 * fields default so a partial-but-valid model answer still produces a deterministic object.
 */
export const parsedOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_event'),
    title: z.string().min(1).max(200),
    date: dateField,
    lunar: lunarField,
    recurrence: recurrenceField,
    leadDays: leadDaysField,
    channels: channelsField,
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('create_expiry'),
    title: z.string().min(1).max(200),
    date: dateField,
    recurrence: recurrenceField,
    leadDays: leadDaysField,
    channels: channelsField,
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('log_interaction'),
    contactName: z.string().min(1).max(120),
    title: z.string().min(1).max(200).nullable().default(null),
    date: dateField,
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('complete_todo'),
    todoId: z.number().int().positive().nullable().default(null),
    title: z.string().min(1).max(200).nullable().default(null),
    date: dateField,
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('log_dose'),
    title: z.string().min(1).max(200),
    amount: z.number().positive().nullable().default(null),
    unit: z.string().min(1).max(20).nullable().default(null),
    date: dateField,
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('log_habit'),
    title: z.string().min(1).max(200),
    amount: z.number().positive().nullable().default(null),
    unit: z.string().min(1).max(20).nullable().default(null),
    date: dateField,
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('query'),
    query: z.string().min(1).max(500),
    confidence: confidenceField,
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: z.string().min(1).max(300).nullable().default(null),
    confidence: confidenceField,
  }),
]);

/** Validated operation (output type: defaults applied, extras stripped). */
export type ParsedOperation = z.infer<typeof parsedOperationSchema>;
export type CreateEventOperation = Extract<ParsedOperation, { kind: 'create_event' }>;
export type CreateExpiryOperation = Extract<ParsedOperation, { kind: 'create_expiry' }>;
export type LogInteractionOperation = Extract<ParsedOperation, { kind: 'log_interaction' }>;
export type CompleteTodoOperation = Extract<ParsedOperation, { kind: 'complete_todo' }>;
export type LogDoseOperation = Extract<ParsedOperation, { kind: 'log_dose' }>;
export type LogHabitOperation = Extract<ParsedOperation, { kind: 'log_habit' }>;
export type QueryOperation = Extract<ParsedOperation, { kind: 'query' }>;
export type UnknownOperation = Extract<ParsedOperation, { kind: 'unknown' }>;

export interface NlParseContext {
  /** Reference instant; the caller injects it so the parser stays deterministic. */
  now: Date;
  /** IANA timezone the "today"/weekday resolution follows. */
  timezone: string;
}

/**
 * Markers that a richer (or non-`create_event`) intent is present. The deterministic layer
 * must not guess these: it returns null and the caller asks a clarifying question.
 */
const COMPLEX_MARKERS =
  /农历|闰|提前|延期|续费|到期|过期|吃药|服药|吃了|记一下|记录|完成|打勾|搞定|查询|查|吗|呢|多少|哪些|有什么|？|\?/;

/** Weekday character → JS day-of-week (0 = Sunday). */
const WEEKDAY_DOW: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

const RELATIVE_DAY_OFFSET: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 昨天: -1 };

interface TokenMatch {
  matched: string;
  value: string;
}

interface RecurrenceMatch {
  matched: string;
  frequency: (typeof RECURRENCE_FREQUENCIES)[number];
  interval: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^[\s,，。.、;；:：-]+|[\s,，。.、;；:：-]+$/g, '').trim();
}

/** Next occurrence of a weekday on or after `today` (UTC calendar arithmetic). */
function nextWeekday(today: string, targetDow: number): string | null {
  const current = new Date(`${today}T00:00:00Z`).getUTCDay();
  const diff = (targetDow - current + 7) % 7;
  return shiftCalendarDays(today, diff);
}

function matchDate(scan: string, today: string): TokenMatch | null {
  const year = today.slice(0, 4);
  let m: RegExpExecArray | null;

  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(scan))) {
    return { matched: m[0], value: `${m[1]}-${m[2]}-${m[3]}` };
  }
  if ((m = /(\d{1,3})\s*天后/.exec(scan))) {
    const value = shiftCalendarDays(today, Number(m[1]));
    return value ? { matched: m[0], value } : null;
  }
  if ((m = /\bin\s+(\d{1,3})\s*days?\b/i.exec(scan))) {
    const value = shiftCalendarDays(today, Number(m[1]));
    return value ? { matched: m[0], value } : null;
  }
  if ((m = /(今天|明天|后天|昨天)/.exec(scan))) {
    const value = shiftCalendarDays(today, RELATIVE_DAY_OFFSET[m[1]]);
    return value ? { matched: m[0], value } : null;
  }
  if ((m = /(\d{1,2})月(\d{1,2})日?/.exec(scan))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { matched: m[0], value: `${year}-${pad2(month)}-${pad2(day)}` };
    }
    return null;
  }
  if ((m = /(?<![\d-])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(scan))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { matched: m[0], value: `${year}-${pad2(month)}-${pad2(day)}` };
    }
    return null;
  }
  if ((m = /周([一二三四五六日天])/.exec(scan))) {
    const value = nextWeekday(today, WEEKDAY_DOW[m[1]]);
    return value ? { matched: m[0], value } : null;
  }
  return null;
}

function matchRecurrence(scan: string): RecurrenceMatch | null {
  let m: RegExpExecArray | null;
  if ((m = /每(?:个)?天/.exec(scan))) return { matched: m[0], frequency: 'daily', interval: 1 };
  if ((m = /每(?:个)?周([一二三四五六日天])?/.exec(scan))) return { matched: m[0], frequency: 'weekly', interval: 1 };
  if ((m = /每(?:个)?月\s*\d{0,2}日?/.exec(scan))) return { matched: m[0], frequency: 'monthly', interval: 1 };
  if ((m = /每(?:个)?年\s*\d{0,2}月?\d{0,2}日?/.exec(scan))) return { matched: m[0], frequency: 'yearly', interval: 1 };
  return null;
}

/**
 * Deterministic parser for the simplest utterances. Returns a schema-validated
 * `create_event` operation, or `null` when the utterance needs the AI layer or a
 * clarifying question. Never throws.
 */
export function parseWithRegex(input: string, ctx: NlParseContext): ParsedOperation | null {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return null;
  if (COMPLEX_MARKERS.test(text)) return null;

  const today = dateStringInTimeZone(ctx.now, ctx.timezone);
  const atIndex = text.lastIndexOf('@');
  const hasAt = atIndex > 0 && text.slice(0, atIndex).trim().length > 0;
  const scan = hasAt ? text.slice(atIndex + 1).trim() : text;

  const recurrence = matchRecurrence(scan);
  const date = matchDate(scan, today);
  if (!date && !recurrence) return null;

  let title: string;
  if (hasAt) {
    title = normalizeTitle(text.slice(0, atIndex));
  } else {
    // Strip the recurrence first (its match may contain the date match, e.g. `每周一` ⊃ `周一`).
    let remainder = text;
    if (recurrence) remainder = remainder.replace(recurrence.matched, ' ');
    if (date) remainder = remainder.replace(date.matched, ' ');
    title = normalizeTitle(remainder);
  }
  if (!title) return null;

  let dateValue = date?.value ?? null;
  if (!dateValue && recurrence) {
    // A recurrence without an explicit start: weekly starts next Monday, otherwise today.
    dateValue =
      recurrence.frequency === 'weekly' ? nextWeekday(today, 1) : today;
  }

  const candidate = {
    kind: 'create_event' as const,
    title,
    date: dateValue,
    lunar: null,
    recurrence: recurrence ? { frequency: recurrence.frequency, interval: recurrence.interval } : null,
    leadDays: null,
    channels: [] as string[],
    confidence: 0.9,
  };

  const parsed = parsedOperationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
