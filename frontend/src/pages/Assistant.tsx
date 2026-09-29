import { useEffect } from 'react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { Button } from '@/components/ui/button';
import { useAssistant } from '@/hooks/useAssistant';
import { useSmartBack } from '@/hooks/useSmartBack';

/**
 * checkbox 109: the dedicated `/assistant` page.
 *
 * It is intentionally thin - the full panel already lives in `components/assistant/AssistantPanel`
 * and is shared with the dock. This page only supplies its own controller instance + page chrome.
 * Mounting a page (or opening the dock) issues NO agent action; `loadTools()` only populates the
 * manual fallback <select>, and nothing is ever executed until the user sends a message.
 */
export default function Assistant() {
  const goBack = useSmartBack();
  const assistant = useAssistant();
  const { loadTools } = assistant;

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto" role="banner" aria-label="智能助手顶部导航">
        <div className="glass-panel rounded-full px-4 py-3 flex items-center gap-3 ring-1 ring-black/5 dark:ring-white/10">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full min-h-11 min-w-11"
            onClick={goBack}
            aria-label="返回上一页"
          >
            <ArrowLeft size={20} aria-hidden />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">智能助手</h1>
            <p className="text-xs text-hint truncate">自然语言操作 · 工具调用全程可见 · 破坏性操作需确认</p>
          </div>
          <Sparkles size={20} className="text-primary-500" aria-hidden />
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-4 py-6" tabIndex={-1}>
        <AssistantPanel assistant={assistant} variant="page" />
      </main>

      <MobileBottomNav />
    </div>
  );
}
