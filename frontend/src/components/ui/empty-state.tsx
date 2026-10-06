import type { ComponentType, ReactNode } from 'react';

/**
 * 全站统一的空状态卡（v2.29 UI 重设计）：
 * 之前 15 处空态有 4 种写法（大卡 / 中卡 / 圆形底座 / 裸文本），圆角与字号各不相同。
 * 统一为 glass-panel 大卡：48px 图标 + 标题 + 描述（可选）+ CTA（可选）。
 * 文案由调用方传入，已有测试断言的文案不变。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-16 glass-panel rounded-[2.5rem] ring-1 ring-black/5 dark:ring-white/10">
      <Icon size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
      <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{title}</h3>
      {description && <p className="text-slate-500 dark:text-slate-400">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
