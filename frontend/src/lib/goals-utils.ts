import type { GoalWithMilestones } from '@timemark/shared';
import { calculateCountdown } from './countdown';

/**
 * 目标页（plan todo 82）的纯展示逻辑。
 *
 * - `goalPercent`：有目标值的用服务端 clamp 的值进度；否则用已完成里程碑占比。
 *   0 个里程碑返回 0（绝不是 NaN）。
 * - `dueCountdownLabel`：复用 lib/countdown.ts 计算到期文案。
 */

export function goalPercent(goal: GoalWithMilestones): number {
  if (goal.milestone_count > 0 && goal.target_value == null) {
    return Math.round((goal.milestone_done_count / goal.milestone_count) * 100);
  }
  if (goal.progress != null) return Math.round(goal.progress);
  if (goal.milestone_count > 0) {
    return Math.round((goal.milestone_done_count / goal.milestone_count) * 100);
  }
  return 0;
}

export function dueCountdownLabel(ymd: string | null): string | null {
  if (!ymd) return null;
  const target = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const { days, isPast } = calculateCountdown(target);
  if (isPast) return days === 0 ? '今天到期' : `已过期 ${days} 天`;
  if (days === 0) return '今天到期';
  return `还有 ${days} 天`;
}
