import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Shield, Bell, Settings, BarChart2 } from 'lucide-react';

const items = [
  { path: '/dashboard', icon: Home, label: '首页' },
  { path: '/analytics', icon: BarChart2, label: '统计' },
  { path: '/reminders', icon: Bell, label: '提醒' },
  { path: '/security', icon: Shield, label: '安全' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-white/10 bg-white/80 dark:bg-slate-900/90 backdrop-blur flex justify-around py-2">
      {items.map(({ path, icon: Icon, label }) => {
        const active = location.pathname === path;
        return (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
            className={`flex flex-col items-center gap-0.5 text-xs px-2 ${active ? 'text-blue-600' : 'text-slate-500'}`}
          >
            <Icon className="w-5 h-5" />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
