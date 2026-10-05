/**
 * checkbox 109: the deterministic natural-language -> tool-call router for the in-app assistant.
 *
 * The assistant does NOT invent a second execution path: it resolves an utterance to one of the
 * registry tool NAMES plus typed arguments, then posts to `/api/agent/actions/:tool`. This module
 * is pure (it reads no clock and performs no I/O) - the caller injects `now`/`timezone`, so it is
 * fully unit-testable and deterministic.
 *
 * "Ask, never guess": an utterance the grammar cannot express faithfully returns `clarify` with a
 * human question rather than a fabricated date or tool call. No tool handler is ever named here -
 * only registry names.
 */

/** A resolved tool call: a real registry name plus the typed args the backend will receive. */
export interface AssistantToolIntent {
  kind: 'tool';
  tool: string;
  args: Record<string, unknown>;
  /** Short human label explaining what the router understood (never a paraphrase of the tool). */
  understood: string;
}

export interface AssistantClarifyIntent {
  kind: 'clarify';
  question: string;
}

export type AssistantIntent = AssistantToolIntent | AssistantClarifyIntent;

export interface AssistantIntentContext {
  now: Date;
  /** IANA timezone the "today"/weekday resolution follows. */
  timezone: string;
}

/** Quick prompts offered in the UI. Kept here so the panel and the tests share one list. */
// v2.28：覆盖新增路由的说法（该联系谁/习惯/规律/搜索）
export const ASSISTANT_QUICK_PROMPTS = ['今天有什么', '下周三提醒我', '这个月花了多少', '该联系谁了', '我的习惯怎么样', '帮我找 租房'] as const;

const QUERY_MARKER = /有什么|有啥|安排|待办|日程|做什么|要做什么/;
const WEEK_MARKER = /本周|这周|这星期|未来(?:七|7)天|最近(?:七|7)天|一周/;
const PENDING_MARKER = /待办|要做|还有什么|没做|该做|还没完成/;
const MONEY_MARKER = /花|消费|支出|账单|续费|到期|过期|订阅|要交|缴费/;
const CREATE_MARKER = /提醒|记一下|记下|帮我记|记录|添加|新建|创建|安排/;

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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Calendar day (YYYY-MM-DD) as observed in `timeZone`; falls back to UTC on an invalid zone. */
export function ymdInTimeZone(now: Date, timeZone: string): string {
  try {
    // en-CA formats a date as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Shift a YYYY-MM-DD calendar day by whole days (UTC arithmetic, DST-free). */
function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/** Monday of the week containing `ymd` (ISO week). */
function mondayOf(ymd: string): string {
  const dow = dayOfWeek(ymd);
  return shiftDays(ymd, dow === 0 ? -6 : 1 - dow);
}

/** A weekday within the CURRENT week (today when it matches). */
function thisWeekWeekday(today: string, targetDow: number): string {
  return shiftDays(mondayOf(today), targetDow === 0 ? 6 : targetDow - 1);
}

/** A weekday within NEXT week (always strictly after this week). */
function nextWeekWeekday(today: string, targetDow: number): string {
  return shiftDays(mondayOf(today), 7 + (targetDow === 0 ? 6 : targetDow - 1));
}

interface DateMatch {
  matched: string;
  value: string;
}

function matchDate(text: string, today: string): DateMatch | null {
  const year = today.slice(0, 4);
  let m: RegExpExecArray | null;

  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(text))) {
    return { matched: m[0], value: `${m[1]}-${m[2]}-${m[3]}` };
  }
  if ((m = /(\d{1,3})\s*天后/.exec(text))) {
    return { matched: m[0], value: shiftDays(today, Number(m[1])) };
  }
  if ((m = /(今天|明天|后天|昨天)/.exec(text))) {
    return { matched: m[0], value: shiftDays(today, RELATIVE_DAY_OFFSET[m[1]]) };
  }
  if ((m = /下(?:个)?周([一二三四五六日天])/.exec(text))) {
    return { matched: m[0], value: nextWeekWeekday(today, WEEKDAY_DOW[m[1]]) };
  }
  if ((m = /(?:这|本)?周([一二三四五六日天])/.exec(text))) {
    return { matched: m[0], value: thisWeekWeekday(today, WEEKDAY_DOW[m[1]]) };
  }
  if ((m = /(\d{1,2})月(\d{1,2})日?/.exec(text))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { matched: m[0], value: `${year}-${pad2(month)}-${pad2(day)}` };
    }
    return null;
  }
  if ((m = /(?<![\d-])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(text))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { matched: m[0], value: `${year}-${pad2(month)}-${pad2(day)}` };
    }
    return null;
  }
  return null;
}

/** Remove the date token, filler verbs and punctuation to leave the event title. */
function extractTitle(text: string, matchedDate: string | null): string {
  let out = text;
  if (matchedDate) out = out.replace(matchedDate, ' ');
  out = out.replace(
    /提醒我一下|提醒我|提醒一下|提醒|帮我|帮忙|记一下|记下|记录一下|记录|记得|添加|新建|创建|安排/g,
    ' ',
  );
  return out.replace(/[@,，。.、;；:：!！?？\s]+/g, ' ').trim();
}

const CLARIFY_NEED_ITEM = '好的，要提醒你什么？例如：下周三 交房租，或 明天提醒我给妈妈打电话。';
const CLARIFY_NEED_DATE = '请补充事项和日期，例如：下周三 交房租，或 2026-10-05 交报告。';
const CLARIFY_UNKNOWN =
  '我没完全听懂。可以试试：今天有什么 / 下周三提醒我交房租 / 这个月花了多少 / 帮我记一下 买牛奶 @ 明天。';

/**
 * Resolve one utterance to a tool call or a clarifying question. Deterministic and side-effect
 * free; never throws.
 */
export function resolveAssistantIntent(text: string, ctx: AssistantIntentContext): AssistantIntent {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { kind: 'clarify', question: CLARIFY_UNKNOWN };

  const today = ymdInTimeZone(ctx.now, ctx.timezone);

  // 1. Destructive: an explicit delete of a numeric event id.
  const del = /(?:删除|删掉|移除|清除)\s*(?:事件|待办|提醒|日程)?\s*#?\s*(\d+)/.exec(raw);
  if (del) {
    const eventId = Number(del[1]);
    if (Number.isInteger(eventId) && eventId > 0) {
      return { kind: 'tool', tool: 'delete_event', args: { eventId }, understood: `删除事件 #${eventId}` };
    }
  }

  // 2. Read/query intents (checked before create so "今天有什么" is a query, not an event).
  if (/今天/.test(raw) && QUERY_MARKER.test(raw)) {
    return { kind: 'tool', tool: 'get_today', args: { includeCompleted: false }, understood: '查看今天的安排' };
  }
  if (WEEK_MARKER.test(raw)) {
    return { kind: 'tool', tool: 'get_week', args: { includeCompleted: false }, understood: '查看本周' };
  }
  if (PENDING_MARKER.test(raw)) {
    return { kind: 'tool', tool: 'list_upcoming', args: { days: 7 }, understood: '查看近期待办' };
  }
  if (MONEY_MARKER.test(raw)) {
    return { kind: 'tool', tool: 'list_expiry', args: { days: 30 }, understood: '查看近 30 天的续费 / 支出' };
  }

  // v2.28：联系/习惯/模式/搜索四类读操作的路由（此前 intent 只覆盖 5 个工具）
  if (/该联系|联系谁|该打电话|多久没联系|联系人清单|stale/.test(raw)) {
    return { kind: 'tool', tool: 'list_contacts_due', args: { withinDays: 14 }, understood: '查看该联系的人（未来 14 天节奏）' };
  }
  if (/习惯|打卡|连续|streak/.test(raw) && !CREATE_MARKER.test(raw)) {
    return { kind: 'tool', tool: 'get_habits', args: { active: true }, understood: '查看习惯与连续打卡' };
  }
  if (/规律|模式|行为|patterns?|我通常|平时什么/.test(raw)) {
    return { kind: 'tool', tool: 'get_patterns', args: { minEvidence: 3 }, understood: '查看系统发现的规律' };
  }
  const find = /(?:找|搜|查|帮我找|搜索)\s*(?:一下\s*)?(?:关于\s*)?["「『]?([一-龥A-Za-z0-9 _-]{2,30})["」』]?/.exec(raw);
  if (find && /找|搜/.test(find[1] + raw.slice(0, 2)) && /找|搜|搜索/.test(raw)) {
    const term = find[1].trim();
    // 排除被 create 分支更合适处理的场景（带日期的创建意图优先走 create）
    if (term && !matchDate(raw, today)) {
      return { kind: 'tool', tool: 'search', args: { text: term }, understood: `搜索「${term}」` };
    }
  }

  // 3. Create with a resolvable date.
  const date = matchDate(raw, today);
  if (date) {
    const title = extractTitle(raw, date.matched);
    if (title) {
      return {
        kind: 'tool',
        tool: 'create_event',
        args: { name: title, date: date.value },
        understood: `创建事件「${title}」${date.value}`,
      };
    }
    return { kind: 'clarify', question: CLARIFY_NEED_ITEM };
  }
  if (CREATE_MARKER.test(raw)) return { kind: 'clarify', question: CLARIFY_NEED_DATE };

  return { kind: 'clarify', question: CLARIFY_UNKNOWN };
}
