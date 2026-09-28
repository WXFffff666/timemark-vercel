import { dateStringInTimeZone, shiftCalendarDays } from '@timemark/shared/habit-schedule';
import { defaultBotDataProvider } from './bot-data.service.js';
import { encodeCallbackData } from './callback-data.js';
import {
  consumeBotLinkCode,
  getActiveBotLink,
  revokeBotLink,
  redactCommandArgs,
  sanitizeAuditText,
  writeBotAuditLog,
  type BotAuditEntry,
  type BotLinkCodeConsumeResult,
  type BotPlatform,
} from './linking.service.js';

/**
 * TimeMark bot command dispatcher (checkbox 92; linking + audit added by checkbox 94).
 *
 * Parses `/command args` (with a Chinese/English alias table) and returns a STRUCTURED
 * reply that the transport layer renders. Handlers never mutate data on their own: only an
 * explicit, user-originated slash command reaches a mutating provider call, and any free
 * text (including quoted/forwarded text) is treated strictly as data.
 *
 * Injected seams (each one is the single place a later checkbox plugs in):
 *  - `provider`  - data access (defaults to the real services in bot-data.service.ts).
 *  - `isLinked`  - chat link check. The default NOW performs the real `bot_links` lookup
 *                  (checkbox 94): only a non-revoked link lets a chat run commands.
 *  - `linking`   - link-code consumption / revocation used by `/link` and `/unlink`.
 *  - `audit`     - one redacted audit row per executed command.
 *  - `parseAdd`  - NL parser for `/add`. Default is the deterministic `标题 @ 日期 时间`
 *                  grammar; checkbox 99 REPLACES it with the AI/typed-decision parser.
 */

export type { BotPlatform } from './linking.service.js';

export interface BotCommandContext {
  platform: BotPlatform;
  chatId: string;
  userId: number;
  /** Active profile for this chat; null = all profiles. */
  profileId: number | null;
  /** Full original message text. Treated strictly as data. */
  text: string;
  /** Telegram chat type when known (private / group / ...); stored with the link. */
  chatType?: string | null;
}

export type BotReplyKind = 'message' | 'ask' | 'help' | 'error';

export interface BotInlineButton {
  text: string;
  callbackData: string;
}

/** Structured reply handed to the transport layer. */
export interface BotReply {
  kind: BotReplyKind;
  text: string;
  /** Optional inline keyboard (checkbox 93 renders it). */
  inlineKeyboard?: BotInlineButton[][];
  /** Machine-readable payload for tests / future transports. */
  data?: Record<string, unknown>;
}

export interface BotPendingItem {
  eventId: number;
  title: string;
  /** Occurrence date, YYYY-MM-DD. */
  date: string;
}

export interface BotDoseItem {
  id: number;
  medicationName: string;
  scheduledFor: string;
  status: string;
}

export interface BotExpiryItem {
  id: number;
  title: string;
  expiresOn: string | null;
  daysUntil: number | null;
}

export interface BotHabitItem {
  id: number;
  name: string;
  currentStreak: number;
  targetMet: boolean;
}

export interface BotProfileItem {
  id: number;
  name: string;
  isDefault: boolean;
}

export interface BotSettings {
  timezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  remindersEnabled: boolean;
  digestEnabled: boolean;
}

export interface BotAddInput {
  title: string;
  date: string;
  time: string | null;
  /** Raw argument text, kept only for the provider/logging; never executed. */
  raw: string;
}

export interface BotAddResult {
  eventId: number;
  title: string;
  date: string;
  time: string | null;
}

/** Data-access seam so the dispatcher is testable without a database. */
export interface BotDataProvider {
  listPending(userId: number, profileId: number | null): Promise<BotPendingItem[]>;
  addItem(userId: number, profileId: number | null, input: BotAddInput): Promise<BotAddResult>;
  completeTodo(userId: number, eventId: number, occurrenceDate: string): Promise<void>;
  snoozeTodo(userId: number, eventId: number, minutes: number): Promise<void>;
  listTodayDoses(userId: number, profileId: number | null): Promise<BotDoseItem[]>;
  listExpiring(userId: number, days: number, profileId: number | null): Promise<BotExpiryItem[]>;
  listHabits(userId: number, profileId: number | null): Promise<BotHabitItem[]>;
  listProfiles(userId: number): Promise<BotProfileItem[]>;
  getSettings(userId: number): Promise<BotSettings>;
  setActiveProfile(userId: number, profileId: number | null): Promise<void>;
}

export type BotLinkCheck = (platform: BotPlatform, chatId: string) => Promise<boolean>;

/**
 * Real link check (checkbox 94): a chat may run commands only while an active
 * (non-revoked) `bot_links` row exists for `(platform, chat_id)`.
 *
 * Linking happens ONLY by consuming a code generated from Settings (`/link <code>`) -
 * never automatically on the first message - so an unlinked chat is refused with
 * `LINK_REQUIRED_REPLY` before any handler or data access runs.
 */
export const defaultBotLinkCheck: BotLinkCheck = async (platform, chatId) => {
  const link = await getActiveBotLink(platform, chatId);
  return link !== null;
};

/** Linking operations `/link` and `/unlink` depend on (injectable seam for tests). */
export interface BotLinkingProvider {
  consumeLinkCode(input: {
    code: unknown;
    platform: BotPlatform;
    chatId: string;
    chatType?: string | null;
  }): Promise<BotLinkCodeConsumeResult>;
  revokeLink(platform: BotPlatform, chatId: string): Promise<boolean>;
}

/** Default linking provider wired to `linking.service.ts` (kept behind a seam for tests). */
export const defaultBotLinkingProvider: BotLinkingProvider = {
  consumeLinkCode: consumeBotLinkCode,
  revokeLink: revokeBotLink,
};

/** Audit sink seam: one redacted row per executed command. */
export type BotAuditSink = (entry: BotAuditEntry) => Promise<void>;

export const defaultBotAuditSink: BotAuditSink = writeBotAuditLog;

export interface ParsedAdd {
  title: string;
  date: string | null;
  time: string | null;
}

export type NlAddParser = (
  input: string,
  ctx: { now: Date; timezone: string },
) => Promise<ParsedAdd | null>;

export interface DispatcherDeps {
  provider?: BotDataProvider;
  isLinked?: BotLinkCheck;
  linking?: BotLinkingProvider;
  audit?: BotAuditSink;
  parseAdd?: NlAddParser;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/** Chinese/English alias table. Values are canonical command ids. */
export const COMMAND_ALIASES: Record<string, string> = {
  start: 'start', 开始: 'start', 你好: 'start', hi: 'start', hello: 'start',
  help: 'help', 帮助: 'help', '?': 'help', 菜单: 'help',
  today: 'today', 今日: 'today', 今天: 'today', 今日待办: 'today',
  week: 'week', 本周: 'week', 这周: 'week', 一周: 'week', 本周待办: 'week',
  list: 'list', 列表: 'list', 待办: 'list', 清单: 'list', 全部待办: 'list',
  done: 'done', 完成: 'done', 搞定: 'done', finished: 'done',
  snooze: 'snooze', 延后: 'snooze', 稍后: 'snooze', 推迟: 'snooze',
  add: 'add', 添加: 'add', 新增: 'add', 加: 'add', 新建: 'add',
  med: 'med', 药: 'med', 用药: 'med', 药物: 'med', medication: 'med',
  expiry: 'expiry', 到期: 'expiry', 过期: 'expiry', 续费: 'expiry',
  habits: 'habits', habit: 'habits', 习惯: 'habits', 打卡: 'habits',
  profile: 'profile', 档案: 'profile', 切换档案: 'profile', 身份: 'profile',
  settings: 'settings', 设置: 'settings', 配置: 'settings',
  link: 'link', 绑定: 'link', 关联: 'link',
  unlink: 'unlink', 解绑: 'unlink', 取消绑定: 'unlink',
};

export interface ParsedCommand {
  command: string;
  args: string;
  known: boolean;
}

/** Parse `/command args` (optionally `/command@botname`). Returns null for non-commands. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  let raw = match[1].toLowerCase();
  const atIdx = raw.indexOf('@');
  if (atIdx > 0) raw = raw.slice(0, atIdx);
  const canonical = COMMAND_ALIASES[raw];
  return { command: canonical ?? raw, args: (match[2] ?? '').trim(), known: canonical !== undefined };
}

export const HELP_TEXT = [
  '🤖 TimeMark 机器人命令：',
  '/help - 显示帮助',
  '/today - 今日待办',
  '/week - 本周待办',
  '/list - 全部待办',
  '/done <序号> - 完成待办',
  '/snooze <序号> <时长> - 延后（如 10m / 1h / 2d / 30分钟）',
  '/add <内容> - 新建事项（标题 @ 日期 时间）',
  '/med - 今日用药',
  '/expiry - 即将到期',
  '/habits - 习惯打卡',
  '/profile <名称> - 切换档案',
  '/settings - 查看设置',
  '/link <绑定码> - 绑定此聊天',
  '/unlink - 解除绑定',
].join('\n');

/** Reply shown to any command from a chat that is not linked yet (checkbox 94 flow). */
export const LINK_REQUIRED_REPLY: BotReply = {
  kind: 'ask',
  text: '🔗 此聊天尚未绑定账号。请在应用「设置 → Telegram 机器人」生成绑定码，然后发送 /link <绑定码> 完成绑定。',
};

/**
 * `/link` + `/unlink` replies. Deliberately DISTINCT per outcome so a user can tell an
 * expired code from an already-used one, and a wrong code from both.
 */
export const LINK_REPLIES = {
  missingCode: '用法：/link <绑定码>。请在应用「设置 → Telegram 机器人」生成绑定码。',
  invalidCode: '❌ 绑定码无效，请在应用「设置 → Telegram 机器人」重新生成。',
  usedCode: '⚠️ 绑定码已被使用过，请在应用「设置 → Telegram 机器人」重新生成。',
  expiredCode: '⌛ 绑定码已过期，请在应用「设置 → Telegram 机器人」重新生成。',
  linked: '✅ 绑定成功，现在可以发送 /help 查看可用命令。',
  unlinked: '✅ 已解除绑定，后续命令将被拒绝。发送 /link <绑定码> 可重新绑定。',
  notLinked: 'ℹ️ 当前聊天尚未绑定账号。',
} as const;

// ---------------------------------------------------------------------------
// /add grammar + duration parsing (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Deterministic fallback grammar: `标题 @ 日期 时间` (also `标题 @ 星期`).
 *
 * Date: `YYYY-MM-DD`, `MM-DD` or `M/D` (current year). Time: `HH:mm` or `H点[MM分]`.
 * Returns `{ title, date: null }` when a title exists but no date is parseable, which the
 * dispatcher turns into a clarifying question (never a silent no-op). Returns null when
 * there is no content at all.
 */
export function parseStrictAddGrammar(input: string, ctx: { now: Date; timezone: string }): ParsedAdd | null {
  const text = input.trim();
  if (!text) return null;

  const at = text.lastIndexOf('@');
  if (at < 0) return { title: text, date: null, time: null };

  const title = text.slice(0, at).trim();
  const rest = text.slice(at + 1).trim();
  if (!title) return null;

  const year = dateStringInTimeZone(ctx.now, ctx.timezone).slice(0, 4);
  let date: string | null = null;
  let time: string | null = null;

  for (const token of rest.split(/\s+/).filter(Boolean)) {
    if (!date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(token)) { date = token; continue; }
      const md = /^(\d{1,2})[-/](\d{1,2})$/.exec(token);
      if (md) {
        const month = Number(md[1]);
        const day = Number(md[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          date = `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
          continue;
        }
      }
    }
    if (!time) {
      const hm = /^(\d{1,2}):(\d{2})$/.exec(token);
      if (hm) {
        const hour = Number(hm[1]);
        const minute = Number(hm[2]);
        if (hour <= 23 && minute <= 59) {
          time = `${hm[1].padStart(2, '0')}:${hm[2]}`;
          continue;
        }
      }
      const cn = /^(\d{1,2})点(?:(\d{1,2})分?)?$/.exec(token);
      if (cn) {
        const hour = Number(cn[1]);
        const minute = Number(cn[2] ?? '0');
        if (hour <= 23 && minute <= 59) {
          time = `${cn[1].padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          continue;
        }
      }
    }
  }

  return { title, date, time };
}

/**
 * Default `/add` parser (deterministic grammar; AI off).
 * Checkbox 99 REPLACES this default via `DispatcherDeps.parseAdd` with the NL/typed-decision
 * parser - the dispatcher itself needs no change.
 */
export const defaultNlAddParser: NlAddParser = async (input, ctx) => parseStrictAddGrammar(input, ctx);

/** Parse a snooze duration to minutes: `10m`, `1h`, `2d`, `30分钟`, `2小时`, `1天`. */
export function parseDurationToMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const minutes = /^(\d+)(m|min|mins|minute|minutes|分钟|分)$/.exec(s);
  if (minutes) return Number(minutes[1]);
  const hours = /^(\d+)(h|hr|hrs|hour|hours|小时|时)$/.exec(s);
  if (hours) return Number(hours[1]) * 60;
  const days = /^(\d+)(d|day|days|天)$/.exec(s);
  if (days) return Number(days[1]) * 1440;
  return null;
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

function message(text: string, data?: Record<string, unknown>, inlineKeyboard?: BotInlineButton[][]): BotReply {
  const reply: BotReply = data ? { kind: 'message', text, data } : { kind: 'message', text };
  if (inlineKeyboard && inlineKeyboard.length > 0) reply.inlineKeyboard = inlineKeyboard;
  return reply;
}
function errorReply(text: string, data?: Record<string, unknown>): BotReply {
  return data ? { kind: 'error', text, data } : { kind: 'error', text };
}
function ask(text: string, data?: Record<string, unknown>): BotReply {
  return data ? { kind: 'ask', text, data } : { kind: 'ask', text };
}
function helpReply(): BotReply {
  return { kind: 'help', text: HELP_TEXT };
}

// ---------------------------------------------------------------------------
// Inline keyboards (checkbox 93)
// ---------------------------------------------------------------------------

/**
 * Inline keyboards are one row per action group and per pending item. Telegram renders the
 * whole keyboard inline, so it is capped to the first `MAX_KEYBOARD_ITEMS` entries; the
 * message body still lists every item.
 */
export const MAX_KEYBOARD_ITEMS = 10;

/**
 * Build the inline keyboard for list-style replies. Every button carries ONLY
 * `{action}:{entity}:{id}[:{minutes}]` (see `callback-data.ts`), never user text, so the
 * payload stays far under Telegram's 64-byte `callback_data` cap.
 */
export function buildTodoInlineKeyboard(items: BotPendingItem[]): BotInlineButton[][] {
  const rows: BotInlineButton[][] = [];
  for (const item of items.slice(0, MAX_KEYBOARD_ITEMS)) {
    const id = item.eventId;
    rows.push([
      { text: '✅ 完成', callbackData: encodeCallbackData({ action: 'done', entity: 'todo', id }) },
      { text: '📂 打开', callbackData: encodeCallbackData({ action: 'open', entity: 'todo', id }) },
    ]);
    rows.push([
      { text: '⏰ 延后 10 分钟', callbackData: encodeCallbackData({ action: 'snooze', entity: 'todo', id, minutes: 10 }) },
      { text: '⏰ 延后 1 小时', callbackData: encodeCallbackData({ action: 'snooze', entity: 'todo', id, minutes: 60 }) },
    ]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch one message. Returns null when the text is not a command (it is data, not an
 * instruction) so the transport sends nothing.
 *
 * `/link` is the ONLY command an unlinked chat may run (it is how a chat becomes linked);
 * `/unlink` is always accepted and reports whether there was a link to revoke. Every other
 * command - known or unknown - requires an active link first.
 */
export async function dispatchCommand(
  ctx: BotCommandContext,
  deps: DispatcherDeps = {},
): Promise<BotReply | null> {
  const parsed = parseCommand(ctx.text);
  if (!parsed) return null;

  const linking = deps.linking ?? defaultBotLinkingProvider;
  let reply: BotReply;
  let auditUserId = ctx.userId;

  if (parsed.command === 'link') {
    const outcome = await handleLink(ctx, linking, parsed.args);
    reply = outcome.reply;
    if (outcome.linkedUserId != null) auditUserId = outcome.linkedUserId;
  } else if (parsed.command === 'unlink') {
    reply = await handleUnlink(ctx, linking);
  } else {
    const isLinked = deps.isLinked ?? defaultBotLinkCheck;
    if (!(await isLinked(ctx.platform, ctx.chatId))) return LINK_REQUIRED_REPLY;

    if (!parsed.known) {
      reply = helpReply();
    } else {
      const provider = deps.provider ?? defaultBotDataProvider;
      const now = (deps.now ?? (() => new Date()))();
      const parseAdd = deps.parseAdd ?? defaultNlAddParser;

      switch (parsed.command) {
        case 'start':
          reply = message(`👋 欢迎使用 TimeMark 机器人！\n\n${HELP_TEXT}`);
          break;
        case 'help':
          reply = helpReply();
          break;
        case 'today':
          reply = await handleRange(ctx, provider, now, 0, 0, '📅 今日待办', '今天没有待办');
          break;
        case 'week':
          reply = await handleRange(ctx, provider, now, 0, 6, '🗓 本周待办', '本周没有待办');
          break;
        case 'list':
          reply = await handleList(ctx, provider);
          break;
        case 'done':
          reply = await handleDone(ctx, provider, parsed.args);
          break;
        case 'snooze':
          reply = await handleSnooze(ctx, provider, parsed.args);
          break;
        case 'add':
          reply = await handleAdd(ctx, provider, parseAdd, now, parsed.args);
          break;
        case 'med':
          reply = await handleMed(ctx, provider);
          break;
        case 'expiry':
          reply = await handleExpiry(ctx, provider);
          break;
        case 'habits':
          reply = await handleHabits(ctx, provider);
          break;
        case 'profile':
          reply = await handleProfile(ctx, provider, parsed.args);
          break;
        case 'settings':
          reply = await handleSettings(ctx, provider);
          break;
        default:
          reply = helpReply();
          break;
      }
    }
  }

  await auditCommand(deps, ctx, parsed.command, parsed.args, reply, auditUserId);
  return reply;
}

async function handleLink(
  ctx: BotCommandContext,
  linking: BotLinkingProvider,
  args: string,
): Promise<{ reply: BotReply; linkedUserId: number | null }> {
  const code = args.trim();
  if (!code) {
    return { reply: errorReply(LINK_REPLIES.missingCode, { reason: 'missing_code' }), linkedUserId: null };
  }

  const result = await linking.consumeLinkCode({
    code,
    platform: ctx.platform,
    chatId: ctx.chatId,
    chatType: ctx.chatType ?? null,
  });

  if (result.status === 'linked' && result.userId != null) {
    return {
      reply: message(LINK_REPLIES.linked, { userId: result.userId }),
      linkedUserId: result.userId,
    };
  }
  if (result.status === 'used') {
    return { reply: errorReply(LINK_REPLIES.usedCode, { reason: 'used_code' }), linkedUserId: null };
  }
  if (result.status === 'expired') {
    return { reply: errorReply(LINK_REPLIES.expiredCode, { reason: 'expired_code' }), linkedUserId: null };
  }
  return { reply: errorReply(LINK_REPLIES.invalidCode, { reason: 'invalid_code' }), linkedUserId: null };
}

async function handleUnlink(ctx: BotCommandContext, linking: BotLinkingProvider): Promise<BotReply> {
  const revoked = await linking.revokeLink(ctx.platform, ctx.chatId);
  if (!revoked) return message(LINK_REPLIES.notLinked, { reason: 'not_linked' });
  return message(LINK_REPLIES.unlinked, { reason: 'unlinked' });
}

/** Short, bounded result summary for the audit row (`kind` or `kind:reason`). */
function summarizeReply(reply: BotReply): string {
  const reason = typeof reply.data?.reason === 'string' ? reply.data.reason : '';
  return (reason ? `${reply.kind}:${reason}` : reply.kind).slice(0, 64);
}

/**
 * Write exactly one audit row per executed command. The row contains a whitelist-built
 * `args_redacted` shape (see `redactCommandArgs`) - never an argument value, code or token.
 * An audit failure must never break command delivery, so it is swallowed after logging.
 */
async function auditCommand(
  deps: DispatcherDeps,
  ctx: BotCommandContext,
  command: string,
  rawArgs: string,
  reply: BotReply,
  userId: number,
): Promise<void> {
  const sink = deps.audit ?? defaultBotAuditSink;
  try {
    await sink({
      userId,
      platform: ctx.platform,
      chatId: sanitizeAuditText(ctx.chatId, 64),
      command: sanitizeAuditText(command, 64),
      argsRedacted: redactCommandArgs(command, rawArgs),
      result: summarizeReply(reply),
    });
  } catch {
    // The reply is already computed; a failed audit write is not a command failure.
  }
}

async function todayInUserTimezone(provider: BotDataProvider, userId: number, now: Date): Promise<string> {
  const settings = await provider.getSettings(userId);
  return dateStringInTimeZone(now, settings.timezone || 'Asia/Shanghai');
}

function formatPending(items: BotPendingItem[]): string {
  return items.map((item, index) => `${index + 1}. ${item.title} · ${item.date}`).join('\n');
}

async function handleList(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const items = await provider.listPending(ctx.userId, ctx.profileId);
  if (items.length === 0) return message('📋 当前没有待办', { count: 0 });
  return message(
    `📋 待办（${items.length}）：\n${formatPending(items)}`,
    { count: items.length },
    buildTodoInlineKeyboard(items),
  );
}

async function handleRange(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  now: Date,
  fromOffset: number,
  toOffset: number,
  title: string,
  emptyText: string,
): Promise<BotReply> {
  const today = await todayInUserTimezone(provider, ctx.userId, now);
  const from = (fromOffset === 0 ? today : shiftCalendarDays(today, fromOffset)) ?? today;
  const to = (toOffset === 0 ? today : shiftCalendarDays(today, toOffset)) ?? today;
  const items = (await provider.listPending(ctx.userId, ctx.profileId))
    .filter((item) => item.date >= from && item.date <= to);
  if (items.length === 0) return message(emptyText, { count: 0 });
  return message(
    `${title}（${items.length}）：\n${formatPending(items)}`,
    { count: items.length },
    buildTodoInlineKeyboard(items),
  );
}

async function handleDone(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  args: string,
): Promise<BotReply> {
  const index = Number(args.trim());
  if (!Number.isInteger(index) || index < 1) {
    return errorReply('用法：/done <序号>，例如 /done 2。发送 /list 查看当前排序。', { reason: 'bad_index' });
  }
  const items = await provider.listPending(ctx.userId, ctx.profileId);
  if (index > items.length) {
    return errorReply(`序号超出范围：当前只有 ${items.length} 项待办。发送 /list 查看。`, {
      reason: 'out_of_range',
      count: items.length,
    });
  }
  const item = items[index - 1];
  await provider.completeTodo(ctx.userId, item.eventId, item.date);
  return message(`✅ 已完成：${item.title}`, { eventId: item.eventId, index });
}

async function handleSnooze(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  args: string,
): Promise<BotReply> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const index = Number(parts[0]);
  if (!Number.isInteger(index) || index < 1) {
    return errorReply('用法：/snooze <序号> <时长>，例如 /snooze 1 10m。', { reason: 'bad_index' });
  }
  const duration = parseDurationToMinutes(parts.slice(1).join(''));
  if (duration === null || duration <= 0) {
    return errorReply('无法识别时长，请使用 10m / 1h / 2d / 30分钟 / 2小时 等格式。', { reason: 'bad_duration' });
  }
  const items = await provider.listPending(ctx.userId, ctx.profileId);
  if (index > items.length) {
    return errorReply(`序号超出范围：当前只有 ${items.length} 项待办。发送 /list 查看。`, {
      reason: 'out_of_range',
      count: items.length,
    });
  }
  const item = items[index - 1];
  await provider.snoozeTodo(ctx.userId, item.eventId, duration);
  return message(`⏰ 已延后 ${duration} 分钟：${item.title}`, { eventId: item.eventId, minutes: duration });
}

async function handleAdd(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  parseAdd: NlAddParser,
  now: Date,
  args: string,
): Promise<BotReply> {
  const timezone = (await provider.getSettings(ctx.userId)).timezone || 'Asia/Shanghai';
  const parsed = await parseAdd(args, { now, timezone });

  if (!parsed || !parsed.title) {
    return ask('请告诉我事项内容，例如：/add 买牛奶 @ 2026-10-01 09:00', { reason: 'clarify' });
  }
  if (!parsed.date) {
    return ask(`「${parsed.title}」要安排在哪一天？请补充日期，例如：/add ${parsed.title} @ 2026-10-01`, {
      reason: 'clarify',
      title: parsed.title,
    });
  }

  const result = await provider.addItem(ctx.userId, ctx.profileId, {
    title: parsed.title,
    date: parsed.date,
    time: parsed.time,
    raw: args,
  });
  const when = result.time ? `${result.date} ${result.time}` : result.date;
  return message(`✅ 已添加：${result.title} · ${when}`, { eventId: result.eventId });
}

async function handleMed(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const doses = await provider.listTodayDoses(ctx.userId, ctx.profileId);
  if (doses.length === 0) return message('💊 今天没有用药安排', { count: 0 });
  const lines = doses.map((dose) => {
    const icon = dose.status === 'taken' ? '✅' : dose.status === 'skipped' ? '⏭️' : '⏳';
    const time = dose.scheduledFor.slice(11, 16) || dose.scheduledFor;
    return `${icon} ${time} ${dose.medicationName}`;
  });
  return message(`💊 今日用药（${doses.length}）：\n${lines.join('\n')}`, { count: doses.length });
}

async function handleExpiry(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const items = await provider.listExpiring(ctx.userId, 30, ctx.profileId);
  if (items.length === 0) return message('🧾 30 天内没有即将到期的事项', { count: 0 });
  const lines = items.map((item) => {
    const suffix = item.daysUntil === null ? '' : `（还有 ${item.daysUntil} 天）`;
    return `${item.title} · ${item.expiresOn ?? '未知'}${suffix}`;
  });
  return message(`🧾 即将到期（${items.length}）：\n${lines.join('\n')}`, { count: items.length });
}

async function handleHabits(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const habits = await provider.listHabits(ctx.userId, ctx.profileId);
  if (habits.length === 0) return message('🌱 还没有习惯，去应用里创建一个吧', { count: 0 });
  const lines = habits.map((habit) => {
    const mark = habit.targetMet ? '✅' : '⏳';
    return `${mark} ${habit.name} · 连续 ${habit.currentStreak} 天`;
  });
  return message(`🌱 习惯打卡（${habits.length}）：\n${lines.join('\n')}`, { count: habits.length });
}

async function handleProfile(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  args: string,
): Promise<BotReply> {
  const profiles = await provider.listProfiles(ctx.userId);
  if (profiles.length === 0) return message('👤 当前没有可用档案');

  const name = args.trim();
  if (!name) {
    const lines = profiles.map((profile) => `${profile.isDefault ? '★' : '·'} ${profile.name}`);
    return message(`👤 可用档案：\n${lines.join('\n')}\n\n使用 /profile <名称> 切换`, { profiles: profiles.length });
  }

  const target = profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
  if (!target) {
    return errorReply(`未找到档案「${name}」。可用：${profiles.map((profile) => profile.name).join('、')}`, {
      reason: 'not_found',
    });
  }
  await provider.setActiveProfile(ctx.userId, target.id);
  return message(`✅ 已切换到档案：${target.name}`, { profileId: target.id });
}

async function handleSettings(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const settings = await provider.getSettings(ctx.userId);
  const quiet = settings.quietHoursStart && settings.quietHoursEnd
    ? `${settings.quietHoursStart} - ${settings.quietHoursEnd}`
    : '未设置';
  const text = [
    '⚙️ 设置',
    `时区：${settings.timezone}`,
    `静默时段：${quiet}`,
    `提醒：${settings.remindersEnabled ? '开启' : '关闭'}`,
    `月报：${settings.digestEnabled ? '开启' : '关闭'}`,
  ].join('\n');
  // Never includes credentials/tokens - settings are display-only.
  return message(text, { timezone: settings.timezone });
}
