import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { useAssistant } from '@/hooks/useAssistant';
import { AssistantPanel } from './AssistantPanel';

/**
 * checkbox 109: a dockable assistant panel available on every authenticated page.
 *
 * It is a self-contained instance (own `useAssistant`), mounted once from App. It is hidden on
 * unauthenticated routes only (the dedicated /assistant page was removed in v2.26 — the dock
 * is the single entry). Opening the panel is the only thing that loads the tool registry.
 */
export function AssistantDock() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // v2.39：大窗模式——用户反馈默认面板"看不全"；展开后手机近全屏、桌面 42rem
  const [expanded, setExpanded] = useState(false);
  const assistant = useAssistant();
  const { loadTools } = assistant;

  useEffect(() => {
    if (open) void loadTools();
  }, [open, loadTools]);

  const excluded =
    location.pathname === '/login' ||
    location.pathname.startsWith('/share/') ||
    location.pathname.startsWith('/embed/');

  if (!isAuthenticated || excluded) return null;

  return (
    <>
      <button
        type="button"
        data-testid="assistant-dock-toggle"
        aria-label={open ? '收起智能助手' : '打开智能助手'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-20 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-b from-blue-500 to-indigo-600 text-white shadow-[0_8px_20px_rgba(79,70,229,0.35)] transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary-500/40 md:bottom-6 md:right-6"
      >
        <Sparkles size={20} aria-hidden />
      </button>

      {/* v2.26 D：面板补出场/退场动画（原为无动画条件渲染） */}
      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="assistant-dock"
            role="dialog"
            aria-label="智能助手"
            // v2.35 R31：外层必须 overflow-hidden 才能真正裁住高度，让面板内部的
            // 滚动区接管。
            // v2.39：①默认尺寸放大（26rem→30rem 宽、70vh→82dvh 高，用户反馈看不全）；
            // ②新增展开态——手机近全屏（inset 定位，上下留出顶栏与悬浮球），
            // 桌面 42rem 大窗；max-h-none 由 inset 撑出边界。
            className={
              expanded
                ? 'fixed inset-x-3 top-14 bottom-36 z-40 flex w-auto max-h-none flex-col overflow-hidden md:inset-x-auto md:top-16 md:right-6 md:bottom-24 md:w-[min(96vw,42rem)]'
                : 'fixed bottom-36 right-4 z-40 flex max-h-[min(82dvh,calc(100dvh-10.5rem))] w-[min(94vw,30rem)] flex-col overflow-hidden md:bottom-24 md:right-6'
            }
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            <AssistantPanel
              assistant={assistant}
              variant="dock"
              expanded={expanded}
              onToggleExpand={() => setExpanded((v) => !v)}
              onClose={() => setOpen(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
