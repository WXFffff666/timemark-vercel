import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CardShellProps {
  title: string;
  icon: ReactNode;
  /** Optional "view all" destination; renders the top-right action when present. */
  href?: string;
  loading?: boolean;
  error?: string | null;
  isEmpty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Shared chrome for every Today card: title + icon, a "view all" action, and the
 * loading / error / empty states each card owns independently.
 */
export function CardShell({
  title,
  icon,
  href,
  loading = false,
  error = null,
  isEmpty = false,
  emptyText = '暂无数据',
  onRetry,
  children,
  className,
}: CardShellProps) {
  const navigate = useNavigate();

  return (
    <Card className={cn('flex h-full flex-col rounded-3xl', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-primary-900/40 dark:text-primary-400"
            aria-hidden
          >
            {icon}
          </span>
          {title}
        </CardTitle>
        {href && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            aria-label={`查看${title}详情`}
            onClick={() => navigate(href)}
          >
            <ArrowUpRight size={16} aria-hidden />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1 p-5 pt-1">
        {loading ? (
          <p className="text-sm text-hint" role="status">
            加载中…
          </p>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle size={14} aria-hidden />
            <span className="flex-1">{error}</span>
            {onRetry && (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                <RefreshCw size={14} aria-hidden /> 重试
              </Button>
            )}
          </div>
        ) : isEmpty ? (
          <p className="text-sm text-hint">{emptyText}</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
