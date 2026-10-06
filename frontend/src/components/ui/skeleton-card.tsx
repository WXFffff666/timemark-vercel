import { cn } from '@/lib/utils';

/**
 * 全站统一的加载骨架卡（v2.29 UI 重设计）：
 * 7 处手写 pulse 块圆角高度互不相同（rounded-[2.5rem]/3xl、h-28/h-48），
 * agent-console 的 Skeleton 原语又只在自己内部用。这里提供两种规格：
 * - Skeleton：基础 pulse 块（自由尺寸）
 * - SkeletonCard：列表页通用的「图标 + 两行文字」骨架卡，默认 3 张
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-slate-200/60 dark:bg-slate-700/50', className)} />;
}

export function SkeletonCard({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-4', className)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="glass-panel rounded-[2.5rem] p-6 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-slate-200/60 dark:bg-slate-700/50" />
            <div className="flex-1">
              <div className="h-5 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/3 mb-3" />
              <div className="h-4 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
