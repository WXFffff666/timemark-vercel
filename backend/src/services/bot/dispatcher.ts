import { dateStringInTimeZone, shiftCalendarDays } from '@timemark/shared/habit-schedule';
import { normalizeTimezone } from '../../utils/timezone.js';
import { defaultBotDataProvider, defaultBotQuietHoursWriter } from './bot-data.service.js';
import {
  CALLBACK_SNOOZE_MAX_MINUTES,
  CALLBACK_SNOOZE_MIN_MINUTES,
  encodeCallbackData,
} from './callback-data.js';
import { escapeMarkdownV2, markdownLink } from './markdown.js';
import { expiryDeepLink, medicationsDeepLink, todoDeepLink } from './deep-links.js';
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
import { containsSecretLike, defaultBotReplyRedactor, type BotReplyRedactor } from './redaction.js';
import {
  BOT_SECURITY_EVENTS,
  defaultBotSecurityEmitter,
  emitBotSecurityEvent,
  sanitizeSecurityField,
  type BotSecurityEmitter,
  type BotSecurityEvent,
  type BotSecurityEventName,
} from './security-events.js';

/**
 * TimeMark bot command dispatcher (checkbox 92; linking + audit by 94; abuse hardening by 96).
 *
 * Parses `/command args` (with a Chinese/English alias table) and returns a STRUCTURED
 * reply that the transport layer renders. Handlers never mutate data on their own: only an
 * explicit, user-originated slash command reaches a mutating provider call, and any free
 * text (including quoted/forwarded text) is treated strictly as data.
 *
 * Checkbox 96 hardening lives here at the single command entry, so every caller is covered:
 *  - a forwarded/quoted DESTRUCTIVE command is refused with a soft confirmation prompt,
 *  - a command carrying credential-shaped material is refused before any handler runs,
 *  - slash-looking but unparseable text is a logged refusal (free text stays a silent no-op),
 *  - every refusal emits exactly ONE structured security event through the `security` seam,
 *  - every outbound reply (text + MarkdownV2) passes the `redactor` before it is returned.
 *  - `fenceUntrusted` (fencing.ts) is the exported helper AI prompts (99/102) must use.
 *
 * Injected seams (each one is the single place a later checkbox plugs in):
 *  - `provider`  - data access (defaults to the real services in bot-data.service.ts).
 *  - `isLinked`  - chat link check. The default NOW performs the real `bot_links` lookup
 *                  (checkbox 94): only a non-revoked link lets a chat run commands.
 *  - `linking`   - link-code consumption / revocation used by `/link` and `/unlink`.
 *  - `audit`     - one redacted audit row per executed command.
 *  - `parseAdd`  - NL parser for `/add`. Default is the deterministic `标题 @ 日期 时间`
 *                  grammar; checkbox 99 REPLACES it with the AI/typed-decision parser.
 *  - `security`  - security-event sink (checkbox 96); defaults to the pino logger.
 *  - `redactor`  - outbound secret scrubber (checkbox 96); defaults to the real one.
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
  /**
   * True when this text arrived through a forward or a quote/reply (checkbox 96).
   * Only DESTRUCTIVE commands care - see `DESTRUCTIVE_COMMANDS`.
   */
  fromForwardedOrQuoted?: boolean;
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
  /**
   * Optional MarkdownV2 rendering of the same reply (checkbox 95). The transport sends it
   * with `parse_mode: MarkdownV2` when present, and falls back to `text` otherwise. Both
   * fields are produced by the same handler so the rich form can never diverge silently.
   */
  markdownText?: string;
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
  /** Absolute instant (UTC ISO) as stored by `medication.service`. */
  scheduledFor: string;
  /** Local `HH:mm` in the profile-or-user timezone ('' when unparseable). */
  localTime: string;
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

/** Chat identity needed to persist per-chat state (the active profile lives on `bot_links`). */
export interface BotChatRef {
  platform: BotPlatform;
  chatId: string;
}

/**
 * Result of a snooze request. `not_found` means the UPDATE matched no event of the acting
 * user (deleted/foreign id): the caller must NOT claim success (defect D2 was a silent
 * no-op with a success reply).
 */
export type BotSnoozeResult =
  | { status: 'ok'; snoozedUntil: string; localTime: string }
  | { status: 'not_found' };

/** Result of a `/profile` switch against the caller's `bot_links` row (defect D3). */
export type BotProfileSwitchResult = 'ok' | 'invalid_profile' | 'not_linked';

/** Data-access seam so the dispatcher is testable without a database. */
export interface BotDataProvider {
  listPending(userId: number, profileId: number | null): Promise<BotPendingItem[]>;
  addItem(userId: number, profileId: number | null, input: BotAddInput): Promise<BotAddResult>;
  completeTodo(userId: number, eventId: number, occurrenceDate: string): Promise<void>;
  snoozeTodo(userId: number, eventId: number, minutes: number): Promise<BotSnoozeResult>;
  listTodayDoses(userId: number, profileId: number | null): Promise<BotDoseItem[]>;
  listExpiring(userId: number, days: number, profileId: number | null): Promise<BotExpiryItem[]>;
  listHabits(userId: number, profileId: number | null): Promise<BotHabitItem[]>;
  listProfiles(userId: number): Promise<BotProfileItem[]>;
  getSettings(userId: number): Promise<BotSettings>;
  setActiveProfile(
    userId: number,
    profileId: number | null,
    chat: BotChatRef,
  ): Promise<BotProfileSwitchResult>;
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
  /** `/quiet` persistence; defaults to writing the existing user config setting. */
  quietHours?: BotQuietHoursWriter;
  now?: () => Date;
  /** Security-event sink (checkbox 96); defaults to the pino-based emitter. */
  security?: BotSecurityEmitter;
  /** Outbound secret scrubber (checkbox 96); defaults to the real redactor. */
  redactor?: BotReplyRedactor;
}

/**
 * `/quiet` writes through the SAME `quiet_hours_start` / `quiet_hours_end` user-config
 * setting the notification dispatcher already reads (`sendNotifications` ->
 * `isInQuietHours`). It is injected only so tests can observe the write without a database.
 */
export type BotQuietHoursWriter = (userId: number, start: string, end: string) => Promise<void>;

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
  quiet: 'quiet', 静默: 'quiet', 免打扰: 'quiet', 静默时段: 'quiet',
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
  '/quiet <开始> <结束> - 设置静默时段（如 22:00 07:00）',
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

/**
 * Commands that delete or revoke state (checkbox 96).
 *
 * A handler that deletes, revokes or otherwise destroys state MUST be added here: a
 * forwarded/quoted copy of one of these commands is NEVER executed, because an attacker
 * could otherwise talk a victim into forwarding a message that unlinks their own chat.
 */
export const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set(['unlink']);

/** Soft confirmation prompt for a forwarded/quoted destructive command. */
export const FORWARDED_DESTRUCTIVE_REPLY = [
  '🔐 这条命令来自转发或引用的内容，出于安全考虑我没有执行。',
  '如果确认是本人操作，请直接在本对话里重新输入 /unlink 并发送（不要转发或引用）。',
].join('\n');

/** Slash-looking text that cannot be parsed at all (e.g. `/`, `//x`). */
export const MALFORMED_COMMAND_REPLY = '❓ 无法解析这条命令。发送 /help 查看可用命令。';

/** A command whose text contains credential-shaped material is refused, never processed. */
export const SECRET_IN_COMMAND_REPLY = [
  '🔒 消息中似乎包含密钥、令牌或密码，为安全起见已拒绝处理。',
  '请勿把密钥类内容发送给机器人；如需记录，请在应用内操作。',
].join('\n');

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

/** Attach the MarkdownV2 rendering; the transport prefers it over `text`. */
function withMarkdown(reply: BotReply, markdownText: string): BotReply {
  reply.markdownText = markdownText;
  return reply;
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
// MarkdownV2 rich rendering, deep links and the 本周 digest (checkbox 95)
// ---------------------------------------------------------------------------

/**
 * `1\. [打开](url) · 2026\-10\-05` - numbering, title and date are escaped as TEXT; only
 * the `[label](url)` pair is intentional markup. Without `APP_BASE_URL` the per-item link
 * is omitted (no broken relative URL) and the line degrades to escaped plain text.
 */
export function formatPendingMarkdown(items: BotPendingItem[]): string {
  return items
    .map((item, index) => {
      const url = todoDeepLink(item.eventId);
      const title = url ? markdownLink(item.title, url) : escapeMarkdownV2(item.title);
      return `${index + 1}\\. ${title} · ${escapeMarkdownV2(item.date)}`;
    })
    .join('\n');
}

/**
 * Compact "本周" digest: one summary line with today / tomorrow / later counts. All
 * characters are digits plus full-width punctuation, so the line is valid MarkdownV2 but
 * is also useful verbatim in the plain-text fallback.
 */
export function buildWeekDigest(items: BotPendingItem[], today: string): string {
  const tomorrow = shiftCalendarDays(today, 1) ?? today;
  const todayCount = items.filter((item) => item.date === today).length;
  const tomorrowCount = items.filter((item) => item.date === tomorrow).length;
  const laterCount = items.length - todayCount - tomorrowCount;
  return `📊 本周速览：共 ${items.length} 项（今天 ${todayCount} · 明天 ${tomorrowCount} · 随后 ${laterCount}）`;
}

/** `/quiet` usage hint. Returned verbatim for every malformed invocation. */
export const QUIET_HOURS_USAGE =
  '用法：/quiet <开始> <结束>，例如 /quiet 22:00 07:00（24 小时制 HH:mm）。';

/**
 * Parse one `/quiet` time token. Accepts `H:mm` / `HH:mm` in 24-hour form and normalises
 * to `HH:mm`; anything else (`25:00`, `abc`, empty) returns null so the caller can refuse
 * the write instead of corrupting the stored setting.
 */
export function parseQuietTime(raw: string): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
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
 *
 * Refusal order (checkbox 96), first match wins and emits exactly one security event:
 * malformed -> forwarded-destructive -> secret-bearing -> unlinked. Rate limiting happens
 * one layer up, in the webhook ingress, before any data access.
 */
export async function dispatchCommand(
  ctx: BotCommandContext,
  deps: DispatcherDeps = {},
): Promise<BotReply | null> {
  const security = deps.security ?? defaultBotSecurityEmitter;
  const redactor = deps.redactor ?? defaultBotReplyRedactor;

  const parsed = parseCommand(ctx.text);
  if (!parsed) {
    // Free text is DATA: no command, no reply (checkbox 92). Text that LOOKS like a command
    // but cannot be parsed (bare `/`, `//x`, `/ `) is a logged refusal (checkbox 96).
    if (!looksLikeCommand(ctx.text)) return null;
    emitRefusal(security, ctx, BOT_SECURITY_EVENTS.malformedCommand, { reason: 'unparseable' });
    return guardReply(
      errorReply(MALFORMED_COMMAND_REPLY, { reason: 'malformed_command' }),
      ctx,
      redactor,
      security,
    );
  }

  // A forwarded/quoted copy of a destructive command is never executed, whatever it says.
  if (ctx.fromForwardedOrQuoted === true && DESTRUCTIVE_COMMANDS.has(parsed.command)) {
    emitRefusal(security, ctx, BOT_SECURITY_EVENTS.forwardedDestructive, {
      command: parsed.command,
      reason: 'forwarded_or_quoted',
    });
    return guardReply(
      ask(FORWARDED_DESTRUCTIVE_REPLY, { reason: 'forwarded_destructive' }),
      ctx,
      redactor,
      security,
    );
  }

  // Credential-shaped commands are refused BEFORE any handler runs: the confirmation reply
  // would otherwise echo the secret back into the chat (checkbox 96 requirement (c)).
  if (containsSecretLike(ctx.text)) {
    emitRefusal(security, ctx, BOT_SECURITY_EVENTS.commandBlockedSecret, {
      reason: 'secret_in_command',
    });
    return guardReply(
      errorReply(SECRET_IN_COMMAND_REPLY, { reason: 'secret_blocked' }),
      ctx,
      redactor,
      security,
    );
  }

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
    if (!(await isLinked(ctx.platform, ctx.chatId))) {
      emitRefusal(security, ctx, BOT_SECURITY_EVENTS.unlinkedCommand, {
        command: parsed.command,
        reason: 'link_required',
      });
      // A copy: the shared constant must never be mutated by the redaction pass.
      return guardReply({ ...LINK_REQUIRED_REPLY }, ctx, redactor, security);
    }

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
          reply = await handleRange(ctx, provider, now, 0, 6, '🗓 本周待办', '本周没有待办', true);
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
        case 'quiet':
          reply = await handleQuiet(ctx, provider, deps.quietHours ?? defaultBotQuietHoursWriter, parsed.args);
          break;
        default:
          reply = helpReply();
          break;
      }
    }
  }

  await auditCommand(deps, ctx, parsed.command, parsed.args, reply, auditUserId);
  return guardReply(reply, ctx, redactor, security);
}

/** Text that is not a slash command is data; only slash-looking text can be "malformed". */
function looksLikeCommand(text: string): boolean {
  return text.trim().startsWith('/');
}

/**
 * Emit one structured security event for a refusal. Only bounded ASCII identifiers are
 * logged (`command`, `reason`, chat id) - never an argument value or message text.
 */
function emitRefusal(
  emitter: BotSecurityEmitter,
  ctx: BotCommandContext,
  event: BotSecurityEventName,
  fields: { command?: string; reason?: string } = {},
): void {
  const payload: BotSecurityEvent = {
    event,
    platform: ctx.platform,
    chatId: sanitizeSecurityField(ctx.chatId),
  };
  if (fields.command) payload.command = sanitizeSecurityField(fields.command);
  if (fields.reason) payload.reason = sanitizeSecurityField(fields.reason);
  emitBotSecurityEvent(emitter, payload);
}

/**
 * The outbound redaction gate (checkbox 96): every reply - plain `text` AND the MarkdownV2
 * rendering - passes through the redactor before being returned, so no handler can leak a
 * configured secret or a full document number. One `bot.security.reply_redacted` event is
 * emitted when anything was scrubbed.
 */
function guardReply(
  reply: BotReply,
  ctx: BotCommandContext,
  redactor: BotReplyRedactor,
  security: BotSecurityEmitter,
): BotReply {
  const kinds = new Set<string>();
  const scrub = (value: string): string => {
    const result = redactor(value);
    for (const kind of result.kinds) kinds.add(kind);
    return result.text;
  };
  reply.text = scrub(reply.text);
  if (typeof reply.markdownText === 'string') reply.markdownText = scrub(reply.markdownText);
  if (kinds.size > 0) {
    emitBotSecurityEvent(security, {
      event: BOT_SECURITY_EVENTS.replyRedacted,
      platform: ctx.platform,
      chatId: sanitizeSecurityField(ctx.chatId),
      redactions: [...kinds],
    });
  }
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
  return dateStringInTimeZone(now, normalizeTimezone(settings.timezone || 'Asia/Shanghai'));
}

function formatPending(items: BotPendingItem[]): string {
  return items.map((item, index) => `${index + 1}. ${item.title} · ${item.date}`).join('\n');
}

async function handleList(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const items = await provider.listPending(ctx.userId, ctx.profileId);
  if (items.length === 0) return message('📋 当前没有待办', { count: 0 });
  const reply = message(
    `📋 待办（${items.length}）：\n${formatPending(items)}`,
    { count: items.length },
    buildTodoInlineKeyboard(items),
  );
  return withMarkdown(reply, `📋 待办（${items.length}）：\n${formatPendingMarkdown(items)}`);
}

async function handleRange(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  now: Date,
  fromOffset: number,
  toOffset: number,
  title: string,
  emptyText: string,
  withDigest = false,
): Promise<BotReply> {
  const today = await todayInUserTimezone(provider, ctx.userId, now);
  const from = (fromOffset === 0 ? today : shiftCalendarDays(today, fromOffset)) ?? today;
  const to = (toOffset === 0 ? today : shiftCalendarDays(today, toOffset)) ?? today;
  const items = (await provider.listPending(ctx.userId, ctx.profileId))
    .filter((item) => item.date >= from && item.date <= to);
  if (items.length === 0) return message(emptyText, { count: 0 });
  const reply = message(
    `${title}（${items.length}）：\n${formatPending(items)}`,
    { count: items.length },
    buildTodoInlineKeyboard(items),
  );
  const head = withDigest
    ? `${title}（${items.length}）：\n${buildWeekDigest(items, today)}\n\n`
    : `${title}（${items.length}）：\n`;
  return withMarkdown(reply, `${head}${formatPendingMarkdown(items)}`);
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
  return withMarkdown(
    message(`✅ 已完成：${item.title}`, { eventId: item.eventId, index }),
    `✅ 已完成：${escapeMarkdownV2(item.title)}`,
  );
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
  // Same 1-minute..7-day bound as the inline-button path (callback-data), so a huge
  // `/snooze 1 999999d` can never pushed the deadline to an overflow/absurd instant.
  if (duration === null || duration < CALLBACK_SNOOZE_MIN_MINUTES || duration > CALLBACK_SNOOZE_MAX_MINUTES) {
    return errorReply('无法识别时长，请使用 10m / 1h / 2d / 30分钟 / 2小时 等格式（最长 7 天）。', {
      reason: 'bad_duration',
    });
  }
  const items = await provider.listPending(ctx.userId, ctx.profileId);
  if (index > items.length) {
    return errorReply(`序号超出范围：当前只有 ${items.length} 项待办。发送 /list 查看。`, {
      reason: 'out_of_range',
      count: items.length,
    });
  }
  const item = items[index - 1];
  const result = await provider.snoozeTodo(ctx.userId, item.eventId, duration);
  if (result.status === 'not_found') {
    // Defect D2: never claim success when nothing was persisted.
    return errorReply(`该事项已不存在：${item.title}`, { reason: 'not_found', eventId: item.eventId });
  }
  // The reply names the persisted deadline (local HH:mm) so it matches the stored state.
  const until = result.localTime || result.snoozedUntil;
  return withMarkdown(
    message(`⏰ 已延后 ${duration} 分钟，将于 ${until} 提醒：${item.title}`, {
      eventId: item.eventId,
      minutes: duration,
      snoozedUntil: result.snoozedUntil,
    }),
    `⏰ 已延后 ${duration} 分钟，将于 ${escapeMarkdownV2(until)} 提醒：${escapeMarkdownV2(item.title)}`,
  );
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
  const url = todoDeepLink(result.eventId);
  const linkLine = url ? `\n🔗 [打开待办](${url})` : '';
  return withMarkdown(
    message(`✅ 已添加：${result.title} · ${when}`, { eventId: result.eventId }),
    `✅ 已添加：${escapeMarkdownV2(result.title)} · ${escapeMarkdownV2(when)}${linkLine}`,
  );
}

async function handleMed(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const doses = await provider.listTodayDoses(ctx.userId, ctx.profileId);
  if (doses.length === 0) return message('💊 今天没有用药安排', { count: 0 });
  const rows = doses.map((dose) => {
    const icon = dose.status === 'taken' ? '✅' : dose.status === 'skipped' ? '⏭️' : '⏳';
    // Defect D4: render the LOCAL clock the data layer computed (`localTime`), never a
    // slice of the UTC ISO string. The raw value remains only as a defensive fallback.
    const time = dose.localTime || dose.scheduledFor;
    return { icon, time, name: dose.medicationName };
  });
  const lines = rows.map((row) => `${row.icon} ${row.time} ${row.name}`);
  const mdLines = rows.map((row) => `${row.icon} ${escapeMarkdownV2(row.time)} ${escapeMarkdownV2(row.name)}`);
  const url = medicationsDeepLink();
  const footer = url ? `\n🔗 [打开用药页](${url})` : '';
  return withMarkdown(
    message(`💊 今日用药（${doses.length}）：\n${lines.join('\n')}`, { count: doses.length }),
    `💊 今日用药（${doses.length}）：\n${mdLines.join('\n')}${footer}`,
  );
}

async function handleExpiry(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const items = await provider.listExpiring(ctx.userId, 30, ctx.profileId);
  if (items.length === 0) return message('🧾 30 天内没有即将到期的事项', { count: 0 });
  const lines = items.map((item) => {
    const suffix = item.daysUntil === null ? '' : `（还有 ${item.daysUntil} 天）`;
    return `${item.title} · ${item.expiresOn ?? '未知'}${suffix}`;
  });
  const mdLines = items.map((item) => {
    const suffix = item.daysUntil === null ? '' : `（还有 ${item.daysUntil} 天）`;
    const url = expiryDeepLink(item.id);
    const title = url ? markdownLink(item.title, url) : escapeMarkdownV2(item.title);
    return `${title} · ${escapeMarkdownV2(item.expiresOn ?? '未知')}${suffix}`;
  });
  return withMarkdown(
    message(`🧾 即将到期（${items.length}）：\n${lines.join('\n')}`, { count: items.length }),
    `🧾 即将到期（${items.length}）：\n${mdLines.join('\n')}`,
  );
}

async function handleHabits(ctx: BotCommandContext, provider: BotDataProvider): Promise<BotReply> {
  const habits = await provider.listHabits(ctx.userId, ctx.profileId);
  if (habits.length === 0) return message('🌱 还没有习惯，去应用里创建一个吧', { count: 0 });
  const lines = habits.map((habit) => {
    const mark = habit.targetMet ? '✅' : '⏳';
    return `${mark} ${habit.name} · 连续 ${habit.currentStreak} 天`;
  });
  const mdLines = habits.map((habit) => {
    const mark = habit.targetMet ? '✅' : '⏳';
    return `${mark} ${escapeMarkdownV2(habit.name)} · 连续 ${habit.currentStreak} 天`;
  });
  return withMarkdown(
    message(`🌱 习惯打卡（${habits.length}）：\n${lines.join('\n')}`, { count: habits.length }),
    `🌱 习惯打卡（${habits.length}）：\n${mdLines.join('\n')}`,
  );
}

/**
 * `/quiet <start> <end>` - persists the EXISTING quiet-hours user setting (the same one
 * `sendNotifications` reads via `isInQuietHours`). A malformed invocation returns the usage
 * hint and performs NO write, so a typo can never clear or corrupt the stored window.
 */
async function handleQuiet(
  ctx: BotCommandContext,
  provider: BotDataProvider,
  writer: BotQuietHoursWriter,
  args: string,
): Promise<BotReply> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const settings = await provider.getSettings(ctx.userId);
    const current = settings.quietHoursStart && settings.quietHoursEnd
      ? `${settings.quietHoursStart} - ${settings.quietHoursEnd}`
      : '未设置';
    return ask(`当前静默时段：${current}\n${QUIET_HOURS_USAGE}`, { reason: 'quiet_hours_usage' });
  }
  if (parts.length !== 2) {
    return errorReply(QUIET_HOURS_USAGE, { reason: 'bad_quiet_hours' });
  }
  const start = parseQuietTime(parts[0]);
  const end = parseQuietTime(parts[1]);
  if (!start || !end) {
    return errorReply(
      `无法识别时间：${parts[0]} / ${parts[1]}。${QUIET_HOURS_USAGE}`,
      { reason: 'bad_quiet_hours' },
    );
  }
  await writer(ctx.userId, start, end);
  return withMarkdown(
    message(`✅ 静默时段已更新：${start} - ${end}。此时段内将不发送提醒。`, {
      quietHoursStart: start,
      quietHoursEnd: end,
    }),
    `✅ 静默时段已更新：${start} \\- ${end}。此时段内将不发送提醒。`,
  );
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
  const outcome = await provider.setActiveProfile(ctx.userId, target.id, {
    platform: ctx.platform,
    chatId: ctx.chatId,
  });
  if (outcome === 'not_linked') {
    // A copy: the shared constant must never be mutated by the redaction pass.
    return { ...LINK_REQUIRED_REPLY };
  }
  if (outcome === 'invalid_profile') {
    return errorReply(`档案「${target.name}」不可用（可能已停用），请发送 /profile 查看可用档案。`, {
      reason: 'invalid_profile',
    });
  }
  const reply = message(`✅ 已切换到档案：${target.name}`, { profileId: target.id });
  // The profile name is user data: escape it for the MarkdownV2 rendering so a name with
  // reserved characters cannot break the message (prompt-injection hardening).
  return withMarkdown(reply, `✅ 已切换到档案：${escapeMarkdownV2(target.name)}`);
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
