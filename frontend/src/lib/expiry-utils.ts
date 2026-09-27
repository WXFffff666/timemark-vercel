/**
 * 到期中心（D1）前端纯函数工具。
 *
 * 只依赖 Wire 形状（蛇形命名，与 `backend/src/services/expiry.service.ts` 的
 * `ExpiryItem` / `ExpiryCostsResult` 对齐）与日期/货币格式化；不含 React、不发请求，
 * 因此可以直接单测「过去日期必须落进 overdue 桶」「大金额不得产出 NaN」等失败场景。
 */

export interface ExpiryItem {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  vendor: string | null;
  amount_cents: number | null;
  currency: string;
  cycle: string;
  cycle_days: number | null;
  start_date: string | null;
  next_due_date: string | null;
  auto_renew: boolean;
  notes: string | null;
  tags: string[];
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ExpiryCosts {
  totalCents: number;
  currency: string | null;
  mixedCurrencies: boolean;
  byCurrency: Record<string, number>;
  byKind: Array<{ kind: string; currency: string; cents: number; count: number }>;
  monthly: Array<{ month: string; currency: string; cents: number }>;
  once: {
    totalCents: number;
    currency: string | null;
    byCurrency: Record<string, number>;
    count: number;
  };
}

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 解析 YYYY-MM-DD 为「本地零点」Date；非法/缺失返回 null（不抛异常）。 */
export function parseLocalYmd(ymd: string | null | undefined): Date | null {
  if (typeof ymd !== 'string') return null;
  const match = YMD_RE.exec(ymd.slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  // Reject roll-over (2026-02-31 → Mar 3, 2026-13-40 → Feb 2027).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** 本地零点（用于整日差比对，避免时区把「今天」算成昨天）。 */
export function startOfLocalDay(ref: Date): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
}

/** target - ref 的整日数；无法解析 → null。 */
export function daysUntil(ymd: string | null | undefined, ref: Date): number | null {
  const target = parseLocalYmd(ymd);
  if (!target) return null;
  const base = startOfLocalDay(ref);
  return Math.round((target.getTime() - base.getTime()) / DAY_MS);
}

export type ExpiryBucket = 'overdue' | 'week' | 'month' | 'later' | 'none';

/**
 * 把到期日归入展示桶：
 * - 过去（< 0 天）→ overdue
 * - 今天起 7 天内 → week
 * - 同一自然月内 → month
 * - 更晚 → later
 * - 无/非法日期 → none（渲染层显示占位，绝不产出 NaN）
 */
export function bucketFor(ymd: string | null | undefined, ref: Date): ExpiryBucket {
  const target = parseLocalYmd(ymd);
  if (!target) return 'none';
  const days = daysUntil(ymd, ref);
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days <= 7) return 'week';
  const base = startOfLocalDay(ref);
  if (target.getFullYear() === base.getFullYear() && target.getMonth() === base.getMonth()) {
    return 'month';
  }
  return 'later';
}

/** 金额（整数分）→ 本地化货币文本；非法输入返回占位符，绝不 NaN。 */
export function formatMoney(
  cents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—';
  const upper = (currency ?? 'CNY').toUpperCase();
  const amount = cents / 100;
  if (!/^[A-Z]{3}$/.test(upper)) {
    return `${amount.toFixed(2)} ${upper}`.trim();
  }
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: upper }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${upper}`;
  }
}

export interface AnnualisedSpend {
  text: string;
  mixed: boolean;
}

/**
 * 年化支出 = 月度折算成本 × 12。
 * 混合货币时不跨币种求和：取金额最大的币种展示并标记 mixed。
 * 空/畸形响应 → `{ text: '—' }`（不崩溃、不 NaN）。
 */
export function annualiseSpend(costs: ExpiryCosts | null | undefined): AnnualisedSpend {
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) {
    return { text: '—', mixed: false };
  }
  const raw = costs.byCurrency;
  const entries: Array<[string, number]> =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      : [];

  if (entries.length === 0) {
    const total = typeof costs.totalCents === 'number' && Number.isFinite(costs.totalCents) ? costs.totalCents : 0;
    return { text: formatMoney(total * 12, costs.currency), mixed: false };
  }

  const declared = costs.currency ? raw[costs.currency] : undefined;
  const selectedCurrency =
    costs.currency && typeof declared === 'number' ? costs.currency : entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const monthly = raw[selectedCurrency];
  const mixed = Boolean(costs.mixedCurrencies) || entries.length > 1;
  const text = formatMoney(typeof monthly === 'number' ? monthly * 12 : null, selectedCurrency);
  return { text, mixed };
}

export interface ExpirySummaryCounts {
  overdue: number;
  week: number;
  month: number;
}

/**
 * 汇总卡片计数。`overdueCount` 优先使用 `/api/expiry/overdue` 的权威计数；
 * 缺失时按本地桶逻辑回退。仅统计激活项（`is_active !== false`）。
 */
export function summariseBuckets(
  items: readonly Pick<ExpiryItem, 'next_due_date' | 'is_active'>[],
  ref: Date,
  overdueCount?: number,
): ExpirySummaryCounts {
  let week = 0;
  let month = 0;
  let localOverdue = 0;
  for (const item of items) {
    if (item.is_active === false) continue;
    const bucket = bucketFor(item.next_due_date, ref);
    if (bucket === 'week') week += 1;
    else if (bucket === 'month') month += 1;
    else if (bucket === 'overdue') localOverdue += 1;
  }
  const overdue =
    typeof overdueCount === 'number' && Number.isFinite(overdueCount) ? overdueCount : localOverdue;
  return { overdue, week, month };
}

export const EXPIRY_KIND_LABELS: Record<string, string> = {
  subscription: '订阅',
  bill: '账单',
  insurance: '保险',
  domain: '域名',
  warranty: '保修',
  custom: '自定义',
};

/** 未知 kind（API 返回脏数据）→ 回退为原字符串，绝不崩溃。 */
export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return '未知';
  return EXPIRY_KIND_LABELS[kind] ?? kind;
}

export const EXPIRY_CYCLE_LABELS: Record<string, string> = {
  once: '一次性',
  monthly: '每月',
  quarterly: '每季度',
  yearly: '每年',
  custom: '自定义',
};

export function cycleLabel(cycle: string | null | undefined): string {
  if (!cycle) return '—';
  return EXPIRY_CYCLE_LABELS[cycle] ?? cycle;
}

export type ExpiryCountdownKind = 'overdue' | 'today' | 'soon' | 'future' | 'unknown';

export interface ExpiryCountdownText {
  kind: ExpiryCountdownKind;
  /** 纯文本，便于断言（例如「已逾期 12 天」「还有 6 天」）。 */
  text: string;
}

/**
 * 供列表展示的倒计时文案。`parts` 来自 `frontend/src/lib/countdown.ts`
 * 的 `calculateCountdown`（days/hours/minutes/isPast）。
 */
export function formatExpiryCountdown(parts: {
  days: number;
  hours: number;
  minutes: number;
  isPast: boolean;
}): ExpiryCountdownText {
  if (!Number.isFinite(parts.days)) return { kind: 'unknown', text: '—' };
  if (parts.days > 0) {
    return { kind: parts.isPast ? 'overdue' : 'future', text: parts.isPast ? `已逾期 ${parts.days} 天` : `还有 ${parts.days} 天` };
  }
  if (parts.isPast) {
    return { kind: 'today', text: '今天已到期' };
  }
  if (parts.hours <= 0 && parts.minutes <= 0) {
    return { kind: 'today', text: '今天到期' };
  }
  return { kind: 'soon', text: `还有 ${parts.hours} 小时 ${parts.minutes} 分` };
}
