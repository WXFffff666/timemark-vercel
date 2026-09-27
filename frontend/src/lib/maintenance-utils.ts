/**
 * 保养计划（D12）前端纯函数工具。
 *
 * 只依赖 Wire 形状（蛇形命名，对齐 backend/src/services/maintenance.service.ts 的
 * `MaintenancePlan` / `MaintenanceLogEntry`）与到期倒计时工具；不含 React、不发请求，
 * 因此可以直接单测「用量进度必须夹在 0..1」「只有用量间隔时不得渲染 NaN 倒计时」。
 */
import { calculateCountdown } from './countdown';
import { formatExpiryCountdown, parseLocalYmd } from './expiry-utils';

export interface MaintenancePlan {
  id: number;
  user_id: number;
  profile_id: number | null;
  asset_name: string;
  asset_kind: string;
  interval_days: number | null;
  interval_usage: number | null;
  usage_unit: string | null;
  current_usage: number | null;
  last_done_at: string | null;
  next_due_at: string | null;
  next_due_usage: number | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface MaintenanceLogEntry {
  id: number;
  plan_id: number;
  done_at: string | null;
  usage_at: number | null;
  cost_cents: number | null;
  notes: string | null;
  created_at: string | null;
}

export const ASSET_KIND_LABELS: Record<string, string> = {
  vehicle: '车辆',
  appliance: '家电',
  device: '设备',
  other: '其它',
};

export const ASSET_KIND_ORDER: readonly string[] = ['vehicle', 'appliance', 'device', 'other'];

export function assetKindLabel(kind: string | null | undefined): string {
  if (!kind) return '其它';
  return ASSET_KIND_LABELS[kind] ?? kind;
}

export const USAGE_UNIT_LABELS: Record<string, string> = {
  km: '公里',
  hours: '小时',
  cycles: '次',
};

export function usageUnitLabel(unit: string | null | undefined): string {
  if (!unit) return '';
  return USAGE_UNIT_LABELS[unit] ?? unit;
}

/** 用量数值 + 单位；非法值 → '—'（绝不 Number(undefined) 出 NaN）。 */
export function formatUsage(value: number | null | undefined, unit: string | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
  const label = usageUnitLabel(unit);
  return label ? `${text} ${label}` : text;
}

export interface UsageProgress {
  /** 已用比例，恒在 0..1（越界夹紧，进度条永不溢出）。 */
  ratio: number;
  percentage: number;
  currentLabel: string;
  nextLabel: string;
}

/**
 * 用量进度：baseline = next_due_usage - interval_usage（上次保养后的起点），
 * used = current_usage - baseline，ratio = used / interval_usage（夹紧 0..1）。
 * 缺少用量间隔 / 下次用量时返回 null —— 调用方渲染占位而不是空进度条。
 */
export function usageProgress(
  plan: Pick<MaintenancePlan, 'interval_usage' | 'next_due_usage' | 'current_usage' | 'usage_unit'>,
): UsageProgress | null {
  const { interval_usage, next_due_usage, current_usage } = plan;
  if (interval_usage == null || !Number.isFinite(interval_usage) || interval_usage <= 0) return null;
  if (next_due_usage == null || !Number.isFinite(next_due_usage)) return null;
  const baseline = next_due_usage - interval_usage;
  const current =
    current_usage != null && Number.isFinite(current_usage) ? current_usage : baseline;
  const used = current - baseline;
  const ratio = Math.min(1, Math.max(0, used / interval_usage));
  return {
    ratio,
    percentage: Math.round(ratio * 100),
    currentLabel: formatUsage(current, plan.usage_unit),
    nextLabel: formatUsage(next_due_usage, plan.usage_unit),
  };
}

export type MaintenanceDueKind = 'overdue' | 'today' | 'soon' | 'future' | 'usage' | 'none';

export interface MaintenanceDueText {
  kind: MaintenanceDueKind;
  text: string;
}

/**
 * 下次保养文案：
 * - 有合法 next_due_at → 复用到期倒计时文案（已逾期 / 还有 N 天）
 * - 只有用量间隔（next_due_at 为空）→ '按用量保养'，绝不渲染 Invalid Date
 * - 两者都缺（脏数据）→ '无下次保养'
 */
export function maintenanceDueText(
  plan: Pick<MaintenancePlan, 'next_due_at' | 'interval_usage'>,
  now: Date,
): MaintenanceDueText {
  const target = parseLocalYmd(plan.next_due_at);
  if (target) {
    const formatted = formatExpiryCountdown(calculateCountdown(target, now));
    if (formatted.kind === 'unknown') return { kind: 'none', text: '无下次保养' };
    return { kind: formatted.kind, text: formatted.text };
  }
  if (plan.interval_usage != null && Number.isFinite(plan.interval_usage)) {
    return { kind: 'usage', text: '按用量保养' };
  }
  return { kind: 'none', text: '无下次保养' };
}

/** 保养日志成本（整数分）→ 元文本；非法输入 → '—'。 */
export function formatCostCents(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}
