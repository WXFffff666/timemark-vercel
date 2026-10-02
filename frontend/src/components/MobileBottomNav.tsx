import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutGrid } from 'lucide-react';
import { prefetchRoute } from '@/lib/prefetch-routes';
import { NAV_GROUPS, NAV_PRIMARY } from '@/lib/nav-groups';
import { getLang, t } from '@/i18n';

/**
 * 应用导航栏。底栏只放 5 个高频入口，其余全部收进「更多」面板并按四组分区。
 *
 * 以前这里是 12 个入口平铺，且另外 8 个已挂载页面（/today /ask /assistant /
 * agent-console /data-health /cron-monitor /lunar-holidays /docker-migration）
 * 一个入口都没有——功能写完了、路由挂上了，用户只能手敲地址。
 * 现在入口由 lib/nav-groups.ts 统一提供，并有测试逐条核对 App.tsx 的受保护路由。
 *
 * 组件名沿用 MobileBottomNav，但它现在各断点都渲染：之前是 md:hidden，而页面的
 * 桌面端没有任何导航，那 8 个页面在桌面端依然只能手敲地址。13/14 个引用它的页面都
 * 预留了 pb-24 底部空间，所以桌面端也不会压住内容。
 */
export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [, setLangTick] = useState(0);

  useEffect(() => {
    const onLang = () => setLangTick((n) => n + 1);
    window.addEventListener('timemark-lang-change', onLang);
    return () => window.removeEventListener('timemark-lang-change', onLang);
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  void getLang();

  const go = (path: string) => {
    setMoreOpen(false);
    navigate(path);
  };

  return (
    <>
      <nav
        className="fixed bottom-0 inset-x-0 z-30 border-t border-white/10 bg-white/80 dark:bg-slate-900/90 backdrop-blur flex justify-around py-2 md:justify-center md:gap-2"
        aria-label="主导航"
      >
        {NAV_PRIMARY.map(({ path, icon: Icon, labelKey }) => {
          const active = location.pathname === path;
          return (
            <button
              key={path}
              type="button"
              onMouseEnter={() => prefetchRoute(path)}
              onFocus={() => prefetchRoute(path)}
              onTouchStart={() => prefetchRoute(path)}
              onClick={() => navigate(path)}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center gap-0.5 text-xs px-2 min-h-11 min-w-11 justify-center ${active ? 'text-blue-600' : 'text-slate-500'}`}
            >
              <Icon className="w-5 h-5" aria-hidden />
              {t(labelKey)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          className="flex flex-col items-center gap-0.5 text-xs px-2 min-h-11 min-w-11 justify-center text-slate-500"
        >
          <LayoutGrid className="w-5 h-5" aria-hidden />
          {t('nav.more')}
        </button>
      </nav>

      {moreOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          onClick={() => setMoreOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.more')}
            className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-[2rem] bg-white dark:bg-slate-900 p-5 pb-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-600" />
            {NAV_GROUPS.map((group) => (
              <section key={group.id} className="mb-5">
                <h2 className="mb-2 px-1 text-xs font-bold uppercase tracking-wider text-slate-400">
                  {t(group.labelKey)}
                </h2>
                <ul className="grid grid-cols-2 gap-1">
                  {group.items.map(({ path, icon: Icon, labelKey }) => {
                    const active = location.pathname === path;
                    return (
                      <li key={path}>
                        <button
                          type="button"
                          onMouseEnter={() => prefetchRoute(path)}
                          onFocus={() => prefetchRoute(path)}
                          onTouchStart={() => prefetchRoute(path)}
                          onClick={() => go(path)}
                          aria-current={active ? 'page' : undefined}
                          className={`flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-sm ${
                            active
                              ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                              : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                          }`}
                        >
                          <Icon className="h-4 w-4 shrink-0" aria-hidden />
                          <span className="truncate">{t(labelKey)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}