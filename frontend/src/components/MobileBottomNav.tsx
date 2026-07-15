import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Shield, Bell, Settings, BarChart2 } from 'lucide-react';
import { prefetchRoute } from '@/lib/prefetch-routes';
import { getLang, t } from '@/i18n';

const items = [
  { path: '/dashboard', icon: Home, labelKey: 'nav.dashboard' as const },
  { path: '/analytics', icon: BarChart2, labelKey: 'nav.analytics' as const },
  { path: '/reminders', icon: Bell, labelKey: 'nav.reminders' as const },
  { path: '/security', icon: Shield, labelKey: 'nav.security' as const },
  { path: '/settings', icon: Settings, labelKey: 'nav.settings' as const },
];

export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setLangTick] = useState(0);

  useEffect(() => {
    const onLang = () => setLangTick((n) => n + 1);
    window.addEventListener('timemark-lang-change', onLang);
    return () => window.removeEventListener('timemark-lang-change', onLang);
  }, []);

  void getLang();

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-white/10 bg-white/80 dark:bg-slate-900/90 backdrop-blur flex justify-around py-2" aria-label="主导航">
      {items.map(({ path, icon: Icon, labelKey }) => {
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
    </nav>
  );
}
