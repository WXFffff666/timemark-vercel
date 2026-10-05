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
            className="fixed bottom-36 right-4 z-40 flex max-h-[70vh] w-[min(92vw,26rem)] flex-col md:bottom-24 md:right-6"
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            <AssistantPanel assistant={assistant} variant="dock" onClose={() => setOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
