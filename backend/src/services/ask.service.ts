/**
 * 确定性 Ask 面板（task 133）。
 *
 * 把一句自由文本问题映射到 **已知意图 + 参数**（纯离线：关键词/别名/正则规则，
 * 零外发网络请求，绝不调用任何 AI），执行真实查询，并用模板渲染答案。
 *
 * 规则：
 * - 识别不了的问题 → 返回「可以问什么」的目录，**绝不猜测答案**。
 * - 歧义问题（如「这个月花了多少」未指明类型）→ 追问并列出可用类型。
 * - 问一个不存在的实体（习惯/药品/支出类型）→ 明确回答「没有找到」，绝不静默返回 0。
 * - 关键词搜索意图委托给 task 132 的 `searchGlobal`（pg_trgm，离线）。
 */

import { EXPIRY_KINDS } from '@timemark/shared';
import { query } from '../db/index.js';
import { listExpiryItems } from './expiry.service.js';
import { listLowStockInventoryItems } from './inventory.service.js';
import { listExpiringDocuments } from './document.service.js';
import { listDueContacts } from './contact-crm.service.js';
import { listHabits } from './habit.service.js';
import { getAdherence } from './medication.service.js';
import { getEventsByUserId } from './event.service.js';
import { searchGlobal } from './search.service.js';

/* ------------------------------------------------------------------ */
/* 意图目录（typed const；GET /api/ask/catalogue 原样返回给前端渲染）    */
/* ------------------------------------------------------------------ */

export const ASK_CATALOGUE_VERSION = 1;

export type AskIntentId =
  | 'spend_by_kind'
  | 'upcoming_30d'
  | 'overdue_items'
  | 'documents_expiring'
  | 'inventory_low'
  | 'contacts_past_cadence'
  | 'habit_streaks'
  | 'medication_adherence'
  | 'completed_this_week'
  | 'keyword_search';

export interface AskParamInfo {
  name: string;
  description: string;
  required: boolean;
}

export interface AskIntentInfo {
  id: AskIntentId;
  /** 简短标题 */
  title: string;
  /** 这个意图回答什么 */
  description: string;
  /** 渲染模板（占位符：{param} / {lines}），答案的文案骨架 */
  template: string;
  /** 示例问法（前端可点击） */
  examples: string[];
  /** 可选/必选参数 */
  params: AskParamInfo[];
}

export const ASK_INTENTS: readonly AskIntentInfo[] = [
  {
    id: 'spend_by_kind',
    title: '本月按类型支出',
    description: '统计本月到期、且填写了金额的到期项（订阅/账单/保险等），按类型与货币分组。未指明类型时会追问。',
    template: '本月（{month}）按类型支出：{lines}（每行「类型：金额（N 项）」；混合货币分行，绝不跨货币求和）',
    examples: ['这个月花了多少', '本月订阅花了多少钱', '这个月的账单支出'],
    params: [
      { name: 'kind', description: '支出类型：subscription / bill / insurance / domain / warranty / custom', required: false },
    ],
  },
  {
    id: 'upcoming_30d',
    title: '未来 30 天',
    description: '合并未来 30 天的事件与到期项，按日期排序。',
    template: '未来 30 天日程：{lines}（每行「YYYY-MM-DD 事件/到期：标题」）',
    examples: ['未来 30 天有什么安排', '接下来有什么日程', '未来30天要处理什么'],
    params: [],
  },
  {
    id: 'overdue_items',
    title: '逾期事项',
    description: '已过到期日、仍未处理的到期项（账单/订阅/保险等）。',
    template: '逾期事项：{lines}（每行「标题（类型）：已逾期 N 天」）',
    examples: ['有什么逾期的事项', '哪些账单逾期了', '有超期未处理的吗'],
    params: [],
  },
  {
    id: 'documents_expiring',
    title: '证件到期（N 天内）',
    description: '默认 30 天内到期或已过期的证件；可在问题中写「N 天」调整。',
    template: '证件到期：{lines}（每行「标题：YYYY-MM-DD（剩 N 天 / 已过期 N 天）」）',
    examples: ['证件30天内到期的有哪些', '护照快过期了吗', '90天内有证件要到期吗'],
    params: [{ name: 'days', description: '窗口天数（1-3650，默认 30）', required: false }],
  },
  {
    id: 'inventory_low',
    title: '低库存物品',
    description: '数量低于各自阈值的库存项。',
    template: '低库存：{lines}（每行「名称：数量 单位 ≤ 阈值 N」）',
    examples: ['哪些库存不足', '有东西快用完了吗', '低库存物品'],
    params: [],
  },
  {
    id: 'contacts_past_cadence',
    title: '该联系的联系人',
    description: '超过各自联系节奏、该问候的联系人。',
    template: '失联联系人：{lines}（每行「名字：已 N 天未联系（节奏 M 天）」）',
    examples: ['谁该联系了', '好久没联系的人', '联系人联系节奏'],
    params: [],
  },
  {
    id: 'habit_streaks',
    title: '习惯连胜',
    description: '每个（活跃）习惯的当前连续与最长纪录；可带习惯名。',
    template: '习惯连胜：{lines}（每行「名称：当前连续 N · 最长 M」）',
    examples: ['习惯连胜情况', '跑步连续多少天了', '每个习惯坚持了多久'],
    params: [{ name: 'entity', description: '习惯名称（可选，模糊匹配）', required: false }],
  },
  {
    id: 'medication_adherence',
    title: '用药依从性',
    description: '最近 N 天（默认 7 天）的整体与逐药品依从率；可带药品名。',
    template: '用药依从性（近 {days} 天）：{lines}（整体百分比 + 每行「药品：xx%（taken/total）」）',
    examples: ['最近吃药依从性怎么样', '阿司匹林的服药情况', '用药按时率'],
    params: [
      { name: 'days', description: '统计天数（1-90，默认 7）', required: false },
      { name: 'entity', description: '药品名称（可选，模糊匹配）', required: false },
    ],
  },
  {
    id: 'completed_this_week',
    title: '本周完成了什么',
    description: '本周（周一起）的待办完成记录。',
    template: '本周完成：{lines}（每行「名称（YYYY-MM-DD）」）',
    examples: ['这周完成了什么', '本周做完的事项', '我这个星期完成了哪些'],
    params: [],
  },
  {
    id: 'keyword_search',
    title: '关键词搜索',
    description: '对全部实体做离线关键词搜索（pg_trgm），委托 task 132 的全局搜索。',
    template: '关键词搜索「{q}」：{lines}（每行「[类型] 标题 — 副标题」）',
    examples: ['搜索 张三', '查找 护照', '搜一下 房租'],
    params: [{ name: 'q', description: '搜索关键词（可省略，从问题正文提取）', required: false }],
  },
];

export interface AskCatalogue {
  version: number;
  intents: readonly AskIntentInfo[];
}

/** 目录：前端「可以问什么」区块的唯一数据源。 */
export function getAskCatalogue(): AskCatalogue {
  return { version: ASK_CATALOGUE_VERSION, intents: ASK_INTENTS };
}

/* ------------------------------------------------------------------ */
/* 回答类型                                                            */
/* ------------------------------------------------------------------ */

export interface AskOption {
  /** 选择后回填到请求 params 的参数名（如 kind） */
  param: string;
  value: string;
  label: string;
}

export interface AskAnswer {
  kind: 'answer';
  intent: AskIntentId;
  question: string;
  title: string;
  lines: string[];
}

export interface AskClarifyAnswer {
  kind: 'clarify';
  intent: AskIntentId;
  question: string;
  message: string;
  options: AskOption[];
}

export interface AskNotFoundAnswer {
  kind: 'not-found';
  intent: AskIntentId;
  question: string;
  message: string;
  available: string[];
}

export interface AskCatalogueAnswer {
  kind: 'catalogue';
  intent: null;
  question: string;
  message: string;
  intents: readonly AskIntentInfo[];
}

export type AskResponse = AskAnswer | AskClarifyAnswer | AskNotFoundAnswer | AskCatalogueAnswer;

/* ------------------------------------------------------------------ */
/* 离线映射规则：关键词 / 别名 / 正则                                    */
/* ------------------------------------------------------------------ */

interface AskRule {
  intent: AskIntentId;
  /** 子串别名（中文为主，小写英文） */
  aliases: string[];
  /** 正则规则（提取/加强） */
  patterns: RegExp[];
}

/**
 * 打分式匹配：命中 1 个别名记 1 分，命中 1 条正则记 2 分；取最高分（并列取目录中靠前者）。
 * 分数为 0 → 无意图 → 返回目录（绝不猜测）。
 */
const ASK_RULES: readonly AskRule[] = [
  {
    intent: 'spend_by_kind',
    aliases: ['花了多少', '花费', '支出', '花销', '开销', '消费', '费用', '花了', 'spend', 'cost', 'expense'],
    patterns: [/(这个月|本月).*花/, /花了多少/],
  },
  {
    intent: 'upcoming_30d',
    aliases: ['未来', '接下来', '即将', '近期', '安排', '日程', 'agenda', 'upcoming'],
    patterns: [/(未来|接下来)\s*\d{1,3}\s*天/, /next\s*30\s*days?/],
  },
  {
    intent: 'overdue_items',
    aliases: ['逾期', '超期', '已过期', '没续费', '未续费', 'overdue'],
    patterns: [/逾期/],
  },
  {
    intent: 'documents_expiring',
    aliases: ['证件', '护照', '身份证', '驾照', '签证', '保单', 'document', 'passport'],
    patterns: [/(证件|护照|身份证|驾照|签证|保单).*(到期|过期)/, /证书.*到期/],
  },
  {
    intent: 'inventory_low',
    aliases: ['库存', '不足', '缺货', '低库存', '用完了', '快没了', 'low stock', 'inventory'],
    patterns: [/库存/, /(快|要)(用完|没了)/],
  },
  {
    intent: 'contacts_past_cadence',
    aliases: ['没联系', '该联系', '好久没', '失联', '联系人', '联系节奏', 'cadence'],
    patterns: [/(该|要)(联系|问候)/, /好久(没|不)(联系|问候)/],
  },
  {
    intent: 'habit_streaks',
    aliases: ['习惯', '连胜', '连续', '打卡', '坚持', 'habit', 'streak'],
    patterns: [/(连续|连胜|打卡)\s*\d*/, /habit/],
  },
  {
    intent: 'medication_adherence',
    aliases: ['吃药', '服药', '用药', '依从', '按时吃', 'adherence', 'medication'],
    patterns: [/(依从|按时(吃|服)药)/],
  },
  {
    intent: 'completed_this_week',
    aliases: ['完成', '做完', '搞定', 'completed'],
    patterns: [/(本周|这周|这个星期).*(完成|做完)/, /this week/],
  },
  {
    intent: 'keyword_search',
    aliases: ['搜索', '搜一下', '搜一搜', '查找', '查询', '找一下', 'search'],
    patterns: [/^(搜索|搜一下|搜一搜|查找|查询|找一下)/],
  },
];

/** 支出类型的中文标签（kind 值来自 EXPIRY_KINDS）。 */
const SPEND_KIND_LABELS: Record<string, string> = {
  subscription: '订阅',
  bill: '账单',
  insurance: '保险',
  domain: '域名',
  warranty: '保修',
  custom: '自定义',
};

/** 中文别名 → kind（用于从问题文本里提取类型参数）。 */
const SPEND_KIND_ALIASES: Record<string, string[]> = {
  subscription: ['订阅', '会员', 'subscription'],
  bill: ['账单', '话费', '水电', '宽带', 'bill'],
  insurance: ['保险', 'insurance'],
  domain: ['域名', 'domain'],
  warranty: ['保修', 'warranty'],
  custom: ['自定义', 'custom'],
};

const SEARCH_TYPE_LABELS: Record<string, string> = {
  event: '事件',
  contact: '联系人',
  interaction: '互动',
  document: '证件',
  expiry: '到期',
  inventory: '物品',
  maintenance: '保养',
  habit: '习惯',
  goal: '目标',
  inbox: '收件箱',
};

function kindLabel(kind: string): string {
  return SPEND_KIND_LABELS[kind] ?? kind;
}

/** 返回最高分意图；0 分（无命中）返回 null。 */
export function matchAskIntent(question: string): AskIntentId | null {
  const q = question.toLowerCase();
  let best: AskIntentId | null = null;
  let bestScore = 0;
  for (const rule of ASK_RULES) {
    let score = 0;
    for (const alias of rule.aliases) {
      if (q.includes(alias.toLowerCase())) score += 1;
    }
    for (const pattern of rule.patterns) {
      if (pattern.test(q)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = rule.intent;
    }
  }
  return best;
}

interface ExtractedParams {
  kind?: string;
  entity?: string;
  days?: number;
  q?: string;
}

const ENTITY_STOPWORDS = new Set(['连胜', '连续', '打卡', '记录', '状态', '情况', '天数', '多长', '怎么样', '吃药', '服药', '用药', '依从', '药', '今天', '这个', '本周', '这周']);

function cleanEntity(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[的了吧吗呢？?！!。，,\s]+$/g, '');
  if (!cleaned || ENTITY_STOPWORDS.has(cleaned)) return undefined;
  return cleaned;
}

function extractDays(question: string): number | undefined {
  const m = question.match(/(\d{1,4})\s*(?:天|日内|days?)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function extractParams(question: string, intent: AskIntentId): ExtractedParams {
  const out: ExtractedParams = {};
  const days = extractDays(question);
  if (days !== undefined) out.days = days;

  const lower = question.toLowerCase();
  for (const kind of EXPIRY_KINDS) {
    const aliases = SPEND_KIND_ALIASES[kind] ?? [];
    if (aliases.some((alias) => lower.includes(alias.toLowerCase()))) {
      out.kind = kind;
      break;
    }
  }

  if (intent === 'habit_streaks') {
    const m =
      question.match(/(?:习惯|habit)[\s「『"']*([^\s「」『』"',，。？?!！]{1,20})/i) ??
      question.match(/([^\s「」『』"',，。？?!！]{1,20})的(?:连续|连胜|打卡)/);
    out.entity = cleanEntity(m?.[1]);
  }
  if (intent === 'medication_adherence') {
    const m = question.match(/([^\s「」『』"',，。？?!！]{1,20})的(?:依从|服药|用药|吃药)/);
    out.entity = cleanEntity(m?.[1]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 日期 / 金额小工具（全部本地计算，零外发）                              */
/* ------------------------------------------------------------------ */

function ymdOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayYmd(): string {
  return ymdOf(new Date());
}

function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function diffDays(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function monthStartOf(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

function nextMonthStartOf(ymd: string): string {
  const [y, m] = ymd.slice(0, 7).split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function formatCents(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function paramString(params: Record<string, string>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 回答问题。`params` 来自歧义追问后的回填（如 `{ kind: 'bill' }`），优先于从文本提取的参数。
 * 永不抛出「猜测性」答案：无意图 → 目录；缺参/歧义 → 追问；实体不存在 → 明确说明。
 */
export async function askQuestion(
  userId: number,
  question: string,
  params: Record<string, string> = {},
): Promise<AskResponse> {
  const q = question.trim();
  const intent = matchAskIntent(q);
  if (!intent) {
    return {
      kind: 'catalogue',
      intent: null,
      question: q,
      message: '这个问题不在离线问答目录里。为避免编造答案，下面列出可以问的内容（全部离线、不调用任何 AI）。',
      intents: ASK_INTENTS,
    };
  }

  const extracted = extractParams(q, intent);
  const merged: ExtractedParams = { ...extracted };
  const pKind = paramString(params, 'kind');
  const pEntity = paramString(params, 'entity');
  const pDays = paramString(params, 'days');
  const pQ = paramString(params, 'q');
  if (pKind) merged.kind = pKind;
  if (pEntity) merged.entity = pEntity;
  if (pQ) merged.q = pQ;
  if (pDays !== undefined) {
    const n = Number(pDays);
    if (Number.isFinite(n) && n > 0) merged.days = n;
  }

  switch (intent) {
    case 'spend_by_kind':
      return answerSpendByKind(userId, q, merged);
    case 'upcoming_30d':
      return answerUpcoming30d(userId, q);
    case 'overdue_items':
      return answerOverdueItems(userId, q);
    case 'documents_expiring':
      return answerDocumentsExpiring(userId, q, merged.days);
    case 'inventory_low':
      return answerInventoryLow(userId, q);
    case 'contacts_past_cadence':
      return answerContactsPastCadence(userId, q);
    case 'habit_streaks':
      return answerHabitStreaks(userId, q, merged.entity);
    case 'medication_adherence':
      return answerMedicationAdherence(userId, q, merged.entity, merged.days);
    case 'completed_this_week':
      return answerCompletedThisWeek(userId, q);
    case 'keyword_search':
      return answerKeywordSearch(userId, q, merged.q);
  }
}

/* ------------------------------------------------------------------ */
/* 各意图实现（真实查询 + 模板渲染）                                     */
/* ------------------------------------------------------------------ */

async function distinctExpiryKinds(userId: number): Promise<string[]> {
  const result = await query(
    'SELECT DISTINCT kind FROM expiry_items WHERE user_id = $1 AND is_active = TRUE',
    [userId],
  );
  return result.rows.map((row) => String((row as { kind: unknown }).kind));
}

async function answerSpendByKind(
  userId: number,
  question: string,
  params: ExtractedParams,
): Promise<AskResponse> {
  const today = todayYmd();
  const month = today.slice(0, 7);
  const monthStart = monthStartOf(today);
  const nextMonthStart = nextMonthStartOf(today);
  const dataKinds = await distinctExpiryKinds(userId);

  const kind = params.kind;
  if (!kind) {
    // 歧义：未指明类型 → 追问，列出可用类型（用户数据 ∪ 领域目录），绝不瞎猜。
    const kinds = [...new Set([...dataKinds, ...EXPIRY_KINDS])];
    return {
      kind: 'clarify',
      intent: 'spend_by_kind',
      question,
      message: `「${month} 花了多少」需要先确定统计哪种支出类型（本月没有类型的默认值，所以不会替你选）：`,
      options: kinds.map((k) => ({
        param: 'kind',
        value: k,
        label: `${kindLabel(k)}（${k}）`,
      })),
    };
  }

  const knownKind = (EXPIRY_KINDS as readonly string[]).includes(kind) || dataKinds.includes(kind);
  if (!knownKind) {
    return {
      kind: 'not-found',
      intent: 'spend_by_kind',
      question,
      message: `没有「${kind}」这种支出类型，无法统计。可用类型：`,
      available: [...new Set([...dataKinds, ...EXPIRY_KINDS])].map((k) => `${kindLabel(k)}（${k}）`),
    };
  }

  const sqlParams: unknown[] = [userId, monthStart, nextMonthStart];
  let kindClause = '';
  if (kind) {
    sqlParams.push(kind);
    kindClause = ` AND kind = $${sqlParams.length}`;
  }
  const result = await query(
    `SELECT kind, currency, COALESCE(SUM(amount_cents), 0)::bigint AS cents, COUNT(*)::int AS count
     FROM expiry_items
     WHERE user_id = $1 AND is_active = TRUE AND amount_cents IS NOT NULL
       AND next_due_date >= $2::date AND next_due_date < $3::date${kindClause}
     GROUP BY kind, currency
     ORDER BY kind ASC, currency ASC`,
    sqlParams,
  );

  const label = kindLabel(kind);
  const title = `本月（${month}）按类型支出`;
  if (result.rows.length === 0) {
    return {
      kind: 'answer',
      intent: 'spend_by_kind',
      question,
      title,
      lines: [`「${label}」本月没有记录应付金额的到期项（仅统计填了金额且到期日在本月的项，不是 0 元消费）。`],
    };
  }

  const rows = result.rows as Array<{ kind: unknown; currency: unknown; cents: unknown; count: unknown }>;
  const lines = rows.map((row) => {
    const k = String(row.kind);
    const currency = String(row.currency ?? 'CNY').toUpperCase();
    const cents = Number(row.cents ?? 0);
    const count = Number(row.count ?? 0);
    return `${kindLabel(k)}：${formatCents(cents, currency)}（${count} 项）`;
  });
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    const currency = String(row.currency ?? 'CNY').toUpperCase();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + Number(row.cents ?? 0));
  }
  if (byCurrency.size === 1) {
    const [currency, cents] = [...byCurrency.entries()][0];
    lines.push(`合计：${formatCents(cents, currency)}`);
  } else {
    lines.push('存在多种货币，按货币分行展示，绝不跨货币求和。');
  }
  return { kind: 'answer', intent: 'spend_by_kind', question, title, lines };
}

async function answerUpcoming30d(userId: number, question: string): Promise<AskResponse> {
  const today = todayYmd();
  const end = shiftYmd(today, 30);
  const events = await getEventsByUserId(String(userId));
  const rows: Array<{ date: string; line: string }> = [];
  for (const event of events) {
    const date = String(event.date ?? '').slice(0, 10);
    if (date >= today && date <= end) {
      rows.push({ date, line: `${date} 事件：${event.name}` });
    }
  }
  const expiry = await listExpiryItems(userId, { active: true, from: today, to: end }, 1, 100);
  for (const item of expiry.items) {
    if (!item.next_due_date) continue;
    rows.push({
      date: item.next_due_date,
      line: `${item.next_due_date} 到期：${item.title}（${kindLabel(item.kind)}）`,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const title = '未来 30 天';
  if (rows.length === 0) {
    return { kind: 'answer', intent: 'upcoming_30d', question, title, lines: ['未来 30 天没有事件或到期项。'] };
  }
  const lines = rows.slice(0, 50).map((row) => row.line);
  if (rows.length > 50) lines.push(`…仅显示前 50 项（共 ${rows.length} 项）`);
  return { kind: 'answer', intent: 'upcoming_30d', question, title, lines };
}

async function answerOverdueItems(userId: number, question: string): Promise<AskResponse> {
  const today = todayYmd();
  const result = await listExpiryItems(userId, { active: true, to: shiftYmd(today, -1) }, 1, 100);
  const title = '逾期事项';
  if (result.items.length === 0) {
    return { kind: 'answer', intent: 'overdue_items', question, title, lines: ['当前没有逾期未处理的到期项。'] };
  }
  const lines = result.items.map((item) => {
    const days = item.next_due_date ? diffDays(item.next_due_date, today) : 0;
    return `${item.title}（${kindLabel(item.kind)}）：应于 ${item.next_due_date} 处理，已逾期 ${days} 天`;
  });
  if (result.total > lines.length) lines.push(`…共 ${result.total} 项逾期（仅显示前 ${lines.length} 项）`);
  return { kind: 'answer', intent: 'overdue_items', question, title, lines };
}

async function answerDocumentsExpiring(
  userId: number,
  question: string,
  rawDays: number | undefined,
): Promise<AskResponse> {
  const days = Math.min(Math.max(Math.trunc(rawDays ?? 30), 1), 3650);
  const today = todayYmd();
  const items = await listExpiringDocuments(userId, days);
  const title = `证件到期（${days} 天内）`;
  if (items.length === 0) {
    return {
      kind: 'answer',
      intent: 'documents_expiring',
      question,
      title,
      lines: [`未来 ${days} 天内没有证件到期或过期。`],
    };
  }
  const lines = items.map((item) => {
    const expires = item.expires_at ?? '';
    const remaining = expires ? diffDays(today, expires) : 0;
    const suffix = remaining >= 0 ? `剩 ${remaining} 天` : `已过期 ${Math.abs(remaining)} 天`;
    return `${item.title}：${expires}（${suffix}）`;
  });
  return { kind: 'answer', intent: 'documents_expiring', question, title, lines };
}

async function answerInventoryLow(userId: number, question: string): Promise<AskResponse> {
  const title = '低库存物品';
  const items = await listLowStockInventoryItems(userId);
  if (items.length === 0) {
    return { kind: 'answer', intent: 'inventory_low', question, title, lines: ['当前没有低于阈值的库存项。'] };
  }
  const lines = items.map((item) => {
    const unit = item.unit ? ` ${item.unit}` : '';
    const threshold = item.low_stock_threshold == null ? '—' : String(item.low_stock_threshold);
    return `${item.name}：${item.quantity}${unit} ≤ 阈值 ${threshold}`;
  });
  return { kind: 'answer', intent: 'inventory_low', question, title, lines };
}

async function answerContactsPastCadence(userId: number, question: string): Promise<AskResponse> {
  const title = '该联系的联系人';
  const contacts = await listDueContacts(userId);
  if (contacts.length === 0) {
    return {
      kind: 'answer',
      intent: 'contacts_past_cadence',
      question,
      title,
      lines: ['所有联系人都还在各自联系节奏内。'],
    };
  }
  const lines = contacts.map((contact) => {
    const cadence = contact.cadence_days;
    const raw = contact.last_contact_at;
    const last = raw ? new Date(raw) : null;
    if (!last || Number.isNaN(last.getTime())) {
      return `${contact.name}：从未记录联系（节奏 ${cadence} 天）`;
    }
    const gap = Math.floor((Date.now() - last.getTime()) / 86_400_000);
    return `${contact.name}：已 ${gap} 天未联系（节奏 ${cadence} 天）`;
  });
  return { kind: 'answer', intent: 'contacts_past_cadence', question, title, lines };
}

async function answerHabitStreaks(
  userId: number,
  question: string,
  entity: string | undefined,
): Promise<AskResponse> {
  const title = '习惯连胜';
  const habits = await listHabits(userId, { active: true });
  if (habits.length === 0) {
    return { kind: 'answer', intent: 'habit_streaks', question, title, lines: ['还没有创建习惯。'] };
  }
  const names = habits.map((habit) => habit.name);
  const matched = entity
    ? habits.filter((habit) => habit.name.toLowerCase().includes(entity.toLowerCase()))
    : habits;
  if (entity && matched.length === 0) {
    // 不存在的实体：明确说「没有找到」，绝不静默返回 0。
    return {
      kind: 'not-found',
      intent: 'habit_streaks',
      question,
      message: `没有找到名为「${entity}」的习惯，无法统计连胜。现有习惯：`,
      available: names,
    };
  }
  const lines = matched.map((habit) => {
    const todayPart = habit.streak.targetMet ? '（今天已达标）' : '';
    return `${habit.name}：当前连续 ${habit.streak.current} · 最长 ${habit.streak.longest}${todayPart}`;
  });
  return { kind: 'answer', intent: 'habit_streaks', question, title, lines };
}

async function answerMedicationAdherence(
  userId: number,
  question: string,
  entity: string | undefined,
  rawDays: number | undefined,
): Promise<AskResponse> {
  const days = Math.min(Math.max(Math.trunc(rawDays ?? 7), 1), 90);
  const today = todayYmd();
  const report = await getAdherence(userId, shiftYmd(today, -(days - 1)), today);
  const title = `用药依从性（近 ${days} 天）`;
  const names = report.medications.map((med) => med.name);
  if (entity) {
    const matched = report.medications.filter((med) => med.name.toLowerCase().includes(entity.toLowerCase()));
    if (matched.length === 0) {
      return {
        kind: 'not-found',
        intent: 'medication_adherence',
        question,
        message: `没有找到名为「${entity}」的药品，无法统计依从性。现有药品：`,
        available: names.length > 0 ? names : ['（当前没有用药记录）'],
      };
    }
    const lines = [
      `整体：${report.overall.percentage}%（${report.overall.taken}/${report.overall.total} 已记录）`,
      ...matched.map((med) => `${med.name}：${med.percentage}%（${med.taken}/${med.total} 已记录）`),
    ];
    return { kind: 'answer', intent: 'medication_adherence', question, title, lines };
  }
  if (report.overall.total === 0) {
    return {
      kind: 'answer',
      intent: 'medication_adherence',
      question,
      title,
      lines: [`近 ${days} 天没有已结算的服药记录（pending 不计入分母）。`],
    };
  }
  const lines = [
    `整体：${report.overall.percentage}%（${report.overall.taken}/${report.overall.total} 已记录，当前连续 ${report.overall.currentStreak} 天）`,
    ...report.medications.map((med) => `${med.name}：${med.percentage}%（${med.taken}/${med.total} 已记录）`),
  ];
  return { kind: 'answer', intent: 'medication_adherence', question, title, lines };
}

async function answerCompletedThisWeek(userId: number, question: string): Promise<AskResponse> {
  const title = '本周完成';
  const result = await query(
    `SELECT e.name AS name, tc.occurrence_date::text AS occurrence_date, tc.completed_at
     FROM todo_completions tc
     JOIN events e ON e.id = tc.event_id AND e.user_id = tc.user_id
     WHERE tc.user_id = $1 AND tc.completed_at >= date_trunc('week', CURRENT_TIMESTAMP)
     ORDER BY tc.completed_at DESC
     LIMIT 100`,
    [userId],
  );
  if (result.rows.length === 0) {
    return { kind: 'answer', intent: 'completed_this_week', question, title, lines: ['本周（周一起）还没有完成记录。'] };
  }
  const lines = result.rows.map((row) => {
    const r = row as { name: unknown; occurrence_date: unknown };
    return `${String(r.name ?? '（无标题）')}（${String(r.occurrence_date ?? '').slice(0, 10)}）`;
  });
  return { kind: 'answer', intent: 'completed_this_week', question, title, lines };
}

async function answerKeywordSearch(
  userId: number,
  question: string,
  explicitQ: string | undefined,
): Promise<AskResponse> {
  const stripped = question
    .replace(/^(请?帮我)?\s*(搜索|搜一下|搜一搜|查找|查询|找一下)\s*/i, '')
    .replace(/^(search|find)\s+/i, '')
    .replace(/[「『"']([^」』"']+)[」』"']$/u, '$1')
    .trim();
  const keyword = explicitQ ?? stripped;

  if (keyword === '' || keyword === question.trim()) {
    return {
      kind: 'clarify',
      intent: 'keyword_search',
      question,
      message: '请告诉我搜索关键词，例如：搜索 张三',
      options: [],
    };
  }

  const result = await searchGlobal(userId, keyword, { limit: 10 });
  const title = `关键词搜索「${keyword}」（共 ${result.total} 条）`;
  if (result.results.length === 0) {
    return { kind: 'answer', intent: 'keyword_search', question, title, lines: [`没有找到与「${keyword}」相关的内容。`] };
  }
  // 明确委托 task 132 的离线 pg_trgm 全局搜索，绝不走语义/外部嵌入。
  const lines = result.results.map((hit) => {
    const label = SEARCH_TYPE_LABELS[hit.owner_type] ?? hit.owner_type;
    return hit.subtitle ? `[${label}] ${hit.title} — ${hit.subtitle}` : `[${label}] ${hit.title}`;
  });
  return { kind: 'answer', intent: 'keyword_search', question, title, lines };
}
