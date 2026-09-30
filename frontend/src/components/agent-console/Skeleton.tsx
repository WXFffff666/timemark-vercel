import { cn } from '@/lib/utils';

/** Minimal local shimmer placeholder (the ui/ primitives ship no Skeleton). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-slate-200/60 dark:bg-slate-700/50', className)} />;
}
