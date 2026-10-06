import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSmartBack } from '@/hooks/useSmartBack';

/**
 * 全站统一的页面 Header（v2.29 UI 重设计）：
 * 之前 22 个页面各自手写 sticky glass pill，出现三种变体 + 四个离群样式
 * （Security 的 top-0 边框条、CronMonitor 的裸 flex、Contacts 的无吸顶、
 * Medications 的 rounded-3xl 分叉），返回逻辑还有 navigate(-1) / useSmartBack /
 * 硬编码 /dashboard 三套。这里一次收口：
 *
 * - 视觉：glass-panel rounded-full + text-xl 标题 + text-xs 副标题，sticky top-6 z-40
 * - 返回：onBack（自定义）> backTo（导航到指定路径）> back="smart"（useSmartBack）> navigate(-1)
 * - 刷新：传 onRefresh 即渲染右上角旋转刷新按钮
 */
export function PageHeader({
  title,
  subtitle,
  onBack,
  backTo,
  back,
  actions,
  onRefresh,
  refreshing,
  maxWidth,
  className,
}: {
  title: string;
  subtitle?: string;
  /** 完全自定义返回行为（优先级最高） */
  onBack?: () => void;
  /** 返回到指定路由（如 '/dashboard'） */
  backTo?: string;
  /** 智能返回：有历史则后退，否则落到兜底路径 */
  back?: 'smart';
  actions?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** 主容器宽度，默认 max-w-4xl */
  maxWidth?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const smartBack = useSmartBack('/dashboard');

  const handleBack = onBack ?? (backTo ? () => navigate(backTo) : back === 'smart' ? smartBack : () => navigate(-1));

  return (
    <header className={`sticky top-6 z-40 px-4 ${maxWidth ?? 'max-w-4xl'} mx-auto ${className ?? ''}`}>
      <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center gap-3 ring-1 ring-black/5 dark:ring-white/10 shadow-xs">
        <div className="flex items-center gap-4 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full min-h-11 min-w-11 shrink-0"
            aria-label="返回"
            onClick={handleBack}
          >
            <ArrowLeft size={20} />
          </Button>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full min-h-11 min-w-11"
              aria-label="刷新"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshCw size={20} className={refreshing ? 'animate-spin' : ''} />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
