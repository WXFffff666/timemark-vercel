import { CheckCircle2, AlertCircle, SkipForward } from 'lucide-react';
import type { DeliveryOutcome } from '@timemark/shared';

/**
 * 投递结果的共享视觉映射（v2.29 UI 重设计）：
 * 之前同一份 delivered/partial/failed/skipped → 图标/颜色/标签的映射在
 * EventReminderLogs、RecentNotifications、TriggerLogs 三处各抄一份，改一处漏两处。
 * 这里收口为单一真相源，按使用场景取字段。
 */
export const OUTCOME_ICON: Record<DeliveryOutcome, typeof CheckCircle2> = {
  delivered: CheckCircle2,
  partial: AlertCircle,
  failed: AlertCircle,
  skipped: SkipForward,
};

export const OUTCOME_LABEL: Record<DeliveryOutcome, string> = {
  delivered: '成功',
  partial: '部分失败',
  failed: '失败',
  skipped: '已跳过',
};

/** 简版文字色（时间线、行内徽标） */
export const OUTCOME_TEXT_CLASS: Record<DeliveryOutcome, string> = {
  delivered: 'text-emerald-500',
  partial: 'text-amber-500',
  failed: 'text-red-500',
  skipped: 'text-slate-400',
};

/** 提醒日志页大卡的底座配色 */
export const OUTCOME_BOX_CLASS: Record<DeliveryOutcome, string> = {
  delivered: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border-emerald-100 dark:border-emerald-800/50',
  partial: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 border-amber-100 dark:border-amber-800/50',
  failed: 'bg-red-50 dark:bg-red-900/30 text-red-600 border-red-100 dark:border-red-800/50',
  skipped: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

/** 徽标变体（与 ui/badge 的 variant 对齐） */
export const OUTCOME_BADGE_VARIANT: Record<DeliveryOutcome, 'success' | 'destructive' | 'secondary'> = {
  delivered: 'success',
  partial: 'secondary',
  failed: 'destructive',
  skipped: 'secondary',
};
