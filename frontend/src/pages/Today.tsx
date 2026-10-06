import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuthStore } from '@/stores/auth.store';
import { prefetchRoute } from '@/lib/prefetch-routes';
import { useTodayCards } from '@/components/today/useTodayCards';
import { TodayCardSettings } from '@/components/today/TodayCardSettings';
import type { TodayCardId } from '@/components/today/cards';
import { TodayEventsCard } from '@/components/today/TodayEventsCard';
import { RemindersCard } from '@/components/today/RemindersCard';
import { DosesCard } from '@/components/today/DosesCard';
import { HabitsDueCard } from '@/components/today/HabitsDueCard';
import { ExpiringCard } from '@/components/today/ExpiringCard';
import { OverdueTodosCard } from '@/components/today/OverdueTodosCard';
import { AiQueueStatusCard } from '@/components/today/AiQueueStatusCard';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const itemVariants = { hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0, transition: { duration: 0.2 } } };

function TodayCard({ id }: { id: TodayCardId }) {
  switch (id) {
    case 'events':
      return <TodayEventsCard />;
    case 'reminders':
      return <RemindersCard />;
    case 'doses':
      return <DosesCard />;
    case 'habits':
      return <HabitsDueCard />;
    case 'expiring':
      return <ExpiringCard />;
    case 'todos':
      return <OverdueTodosCard />;
    case 'ai':
      return <AiQueueStatusCard />;
    default:
      return null;
  }
}

/** Task 136: the configurable Today at-a-glance dashboard. */
export default function Today() {
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.user?.id);
  const todayCards = useTodayCards(userId);

  useEffect(() => {
    prefetchRoute('/calendar');
    prefetchRoute('/todos');
    prefetchRoute('/expiry');
    prefetchRoute('/habits');
    prefetchRoute('/medications');
  }, []);

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="今日概览"
        subtitle="可配置卡片 · 每张卡片独立加载"
        back="smart"
        maxWidth="max-w-7xl"
        actions={<TodayCardSettings {...todayCards} />}
      />

      <main id="main-content" className="mx-auto max-w-7xl px-4 py-8" tabIndex={-1}>
        {todayCards.visibleOrder.length === 0 ? (
          <div className="glass-panel rounded-3xl py-16 text-center">
            <p className="font-semibold text-slate-700 dark:text-slate-200">已隐藏全部卡片</p>
            <p className="mt-1 text-sm text-hint">打开「配置卡片」重新显示需要的卡片</p>
            <Button variant="outline" className="mt-4 rounded-full" onClick={() => navigate('/dashboard')}>
              返回首页
            </Button>
          </div>
        ) : (
          <motion.div
            initial="hidden"
            animate="visible"
            variants={containerVariants}
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          >
            {todayCards.visibleOrder.map((id) => (
              <motion.div
                key={id}
                variants={itemVariants}
                className={id === 'ai' ? 'md:col-span-2 xl:col-span-3' : undefined}
              >
                <TodayCard id={id} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>
    </div>
  );
}
