import { dateStringInTimeZone, shiftCalendarDays } from '@timemark/shared/habit-schedule';
import { defaultBotDataProvider } from './bot-data.service.js';

/**
 * TimeMark bot command dispatcher (checkbox 92).
 *
 * Parses `/command args` (with a Chinese/English alias table) and returns a STRUCTURED
 * reply that the transport layer renders. Handlers never mutate data on their own: only an
 * explicit, user-originated slash command reaches a mutating provider call, and any free
 * text (including quoted/forwarded text) is treated strictly as data.
 *
 * Injected seams (each one is the single place a later checkbox plugs in):
 *  - `provider`  - data access (defaults to the real services in bot-data.service.ts).
 *  - `isLinked`  - chat link check. Default treats every chat as linked because the
 *                  `bot_links` table only lands in checkbox 94; 94 REPLACES the default
 *                  with a real DB lookup. See `defaultBotLinkCheck`.
 *  - `parseAdd`  - NL parser for `/add`. Default is the deterministic `标题 @ 日期 时间`
 *                  grammar; checkbox 99 REPLACES it with the AI/typed-decision parser.
 */

export type BotPlatform = 'telegram';

export interface BotCommandContext {
  platform: BotPlatform;
  chatId: string;
  userId: number;
  /** Active profile for this chat; null = all profiles. */
  profileId: number | null;
  /** Full original message text. Treated strictly as data. */
  text: string;
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
 * Default link check, used until checkbox 94 creates the `bot_links` table.
 *
 * The app is single-user by design, so while no link store exists every chat is treated as
 * linked (otherwise every command would be rejected before 94 lands). Checkbox 94 REPLACES
 * this default with a real `bot_links` lookup - this constant is the ONLY place that changes.
 */
export const defaultBotLinkCheck: BotLinkCheck = async () => true;

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
].join('\n');

/** Reply shown to any command from a chat that is not linked yet (checkbox 94 flow). */
export const LINK_REQUIRED_REPLY: BotReply = {
  kind: 'ask',
  text: '🔗 此聊天尚未绑定账号。请在应用「设置 → Telegram 机器人」生成绑定码，然后发送 /link <绑定码> 完成绑定。',
};

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

function message(text: string, data?: Record<string, unknown>): BotReply {
  return data ? { kind: 'message', text, data } : { kind: 'message', text };
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
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch one message. Returns null when the text is not a command (it is data, not an
 * instruction) so the transport sends nothing.
 */
export async function dispatchCommand(
  ctx: BotCommandContext,
  deps: DispatcherDeps = {},
): Promise<BotReply | null> {
  const parsed = parseCommand(ctx.text);
  if (!parsed) return null;

  const isLinked = deps.isLinked ?? defaultBotLinkCheck;
  if (!(await isLinked(ctx.platform, ctx.chatId))) return LINK_REQUIRED_REPLY;

  if (!parsed.known) return helpReply();

  const provider = deps.provider ?? defaultBotDataProvider;
  const now = (deps.now ?? (() => new Date()))();
  const parseAdd = deps.parseAdd ?? defaultNlAddParser;

  switch (parsed.command) {
    case 'start':
      return message(`👋 欢迎使用 TimeMark 机器人！\n\n${HELP_TEXT}`);
    case 'help':
      return helpReply();
    case 'today':
      return handleRange(ctx, provider, now, 0, 0, '📅 今日待办', '今天没有待办');
    case 'week':
      return handleRange(ctx, provider, now, 0, 6, '🗓 本周待办', '本周没有待办');
    case 'list':
      return handleList(ctx, provider);
    case 'done':
      return handleDone(ctx, provider, parsed.args);
    case 'snooze':
      return handleSnooze(ctx, provider, parsed.args);
    case 'add':
      return handleAdd(ctx, provider, parseAdd, now, parsed.args);
    case 'med':
      return handleMed(ctx, provider);
    case 'expiry':
      return handleExpiry(ctx, provider);
    case 'habits':
      return handleHabits(ctx, provider);
    case 'profile':
      return handleProfile(ctx, provider, parsed.args);
    case 'settings':
      return handleSettings(ctx, provider);
    default:
      return helpReply();
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
  return message(`📋 待办（${items.length}）：\n${formatPending(items)}`, { count: items.length });
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
  return message(`${title}（${items.length}）：\n${formatPending(items)}`, { count: items.length });
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
