import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, CalendarCheck, Flame, Lightbulb, Package, Target, TrendingUp } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCard } from '@/components/ui/skeleton-card';
import { api } from '@/lib/api';

/**
 * v2.42 R24：周回顾页（/review）——周回顾仪式（Griply/Discy 2026 趋势）的
 * 确定性实现：全部数据来自现有端点，建议由规则生成（不假 AI）。
 */

type DailyRow = { stat_date: string; events_count: number; triggers_total: number; triggers_success: number; triggers_failed: number };
type HabitRow = { id: number; name: string; icon?: string | null; streak: { current: number; longest: number } | null };
type ExpiryRow = { id: number; title: string; expires_at?: string; kind?: string };
type GoalRow = { id: number; title: string; status: string; milestones?: Array<{ id: number; completed: boolean }>; dueDate?: string | null };

interface Suggestion {
  tone: 'good' | 'warn' | 'info';
  text: string;
  href?: string;
  action?: string;
}

/** 本周一（isoWeek）的 YYYY-MM-DD */
function mondayOfThisWeek(): string {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // 周一=0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

/** 数据驱动建议（确定性规则，不假 AI） */
export function buildWeeklySuggestions(input: {
  eventsThisWeek: number;
  triggersFailed: number;
  topHabit: string | null;
  topStreak: number;
  expiringSoon: number;
  activeGoals: number;
}): Suggestion[] {
  const out: Suggestion[] = [];
  if (input.triggersFailed > 0) {
    out.push({ tone: 'warn', text: `本周有 ${input.triggersFailed} 条提醒发送失败，建议查看触发日志排查渠道`, href: '/trigger-logs', action: '查看日志' });
  }
  if (input.expiringSoon > 0) {
    out.push({ tone: 'info', text: `未来 7 天有 ${input.expiringSoon} 项即将到期，提前处理避免错过`, href: '/expiry', action: '去处理' });
  }
  if (input.topHabit && input.topStreak >= 7) {
    out.push({ tone: 'good', text: `「${input.topHabit}」已连续打卡 ${input.topStreak} 天，保持节奏！` });
  }
  if (input.eventsThisWeek === 0 && input.activeGoals > 0) {
    out.push({ tone: 'info', text: '本周还没有新增事件——把下周的重要日子先记进来', href: '/events', action: '去添加' });
  }
  if (out.length === 0) {
    out.push({ tone: 'good', text: '本周一切平稳，没有需要注意的事项。继续保持！' });
  }
  return out;
}

/** v2.42 R24：周回顾 */
export function WeeklyReview() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [upcoming, setUpcoming] = useState<ExpiryRow[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [dailyRes, habitRes, expiryRes, goalRes] = await Promise.all([
          api.get<DailyRow[]>('/stats/daily?days=7'),
          api.get<HabitRow[]>('/habits'),
          api.get<ExpiryRow[]>('/expiry/upcoming?days=7'),
          api.get<GoalRow[]>('/goals'),
        ]);
        setDaily(Array.isArray(dailyRes) ? dailyRes : []);
        setHabits(Array.isArray(habitRes) ? habitRes : []);
        setUpcoming(Array.isArray(expiryRes) ? expiryRes : []);
        setGoals(Array.isArray(goalRes) ? goalRes : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const monday = mondayOfThisWeek();
  const thisWeek = useMemo(() => daily.filter((r) => r.stat_date >= monday), [daily, monday]);
  const eventsThisWeek = thisWeek.reduce((sum, r) => sum + (r.events_count || 0), 0);
  const triggersTotal = thisWeek.reduce((sum, r) => sum + (r.triggers_total || 0), 0);
  const triggersFailed = thisWeek.reduce((sum, r) => sum + (r.triggers_failed || 0), 0);
  const successRate = triggersTotal > 0 ? Math.round(((triggersTotal - triggersFailed) / triggersTotal) * 100) : null;

  const habitBoard = useMemo(
    () => [...habits].filter((h) => (h.streak?.current ?? 0) > 0).sort((a, b) => (b.streak?.current ?? 0) - (a.streak?.current ?? 0)).slice(0, 5),
    [habits],
  );

  const activeGoals = useMemo(() => goals.filter((g) => g.status === 'active'), [goals]);

  const suggestions = useMemo(
    () => buildWeeklySuggestions({
      eventsThisWeek,
      triggersFailed,
      topHabit: habitBoard[0]?.name ?? null,
      topStreak: habitBoard[0]?.streak?.current ?? 0,
      expiringSoon: upcoming.length,
      activeGoals: activeGoals.length,
    }),
    [eventsThisWeek, triggersFailed, habitBoard, upcoming.length, activeGoals.length],
  );

  if (loading) {
    return (
      <div className="min-h-screen pb-24">
        <PageHeader title="本周回顾" subtitle="数据驱动的每周复盘" maxWidth="max-w-4xl" />
        <main className="max-w-4xl mx-auto px-6 mt-6">
          <SkeletonCard count={3} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <PageHeader title="本周回顾" subtitle={`本周（自 ${monday.slice(5)}）· 数据驱动 · 不假 AI`} maxWidth="max-w-4xl" />
      <main className="max-w-4xl mx-auto px-6 mt-6 space-y-5">
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {/* 建议条 */}
        <section aria-label="本周建议" className="space-y-2">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className={`glass-panel rounded-2xl px-4 py-3 flex items-center gap-3 text-sm ${
                s.tone === 'good' ? 'border border-emerald-200/70 dark:border-emerald-800/50' : s.tone === 'warn' ? 'border border-red-200/70 dark:border-red-800/50' : 'border border-blue-200/70 dark:border-blue-800/50'
              }`}
            >
              <Lightbulb size={16} className={s.tone === 'good' ? 'text-emerald-500' : s.tone === 'warn' ? 'text-red-500' : 'text-blue-500'} aria-hidden />
              <span className="flex-1 text-slate-700 dark:text-slate-200">{s.text}</span>
              {s.href && (
                <button type="button" className="text-xs font-bold text-primary-600 dark:text-primary-400 hover:underline" onClick={() => navigate(s.href!)}>
                  {s.action ?? '去处理'} <ArrowRight size={12} className="inline" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </section>

        {/* 本周数字 */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-label="本周统计">
          <div className="glass-panel rounded-2xl p-4">
            <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{eventsThisWeek}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1"><CalendarCheck size={12} aria-hidden /> 本周事件</p>
          </div>
          <div className="glass-panel rounded-2xl p-4">
            <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{triggersTotal}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1"><Activity size={12} aria-hidden /> 提醒发送</p>
          </div>
          <div className="glass-panel rounded-2xl p-4">
            <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{successRate === null ? '—' : `${successRate}%`}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1"><TrendingUp size={12} aria-hidden /> 发送成功率</p>
          </div>
          <div className="glass-panel rounded-2xl p-4">
            <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{upcoming.length}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1"><Package size={12} aria-hidden /> 7 天内到期</p>
          </div>
        </section>

        {/* 习惯连击榜 */}
        <section className="glass-panel rounded-3xl p-5" aria-label="习惯连击榜">
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
            <Flame size={14} aria-hidden /> 习惯连击榜
          </h2>
          {habitBoard.length === 0 ? (
            <EmptyState icon={Flame} title="还没有连击中的习惯" description="去习惯页打卡，连击会在这里出现" />
          ) : (
            <ul className="space-y-2">
              {habitBoard.map((h, i) => (
                <li key={h.id} className="flex items-center gap-3 text-sm">
                  <span className="w-6 text-center text-slate-400 font-bold">{i + 1}</span>
                  <span className="text-lg">{h.icon || '🔥'}</span>
                  <span className="flex-1 text-slate-700 dark:text-slate-200">{h.name}</span>
                  <span className="font-bold text-amber-500">{h.streak?.current ?? 0} 天</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 7 天到期前瞻 */}
        <section className="glass-panel rounded-3xl p-5" aria-label="到期前瞻">
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
            <Package size={14} aria-hidden /> 7 天内到期
          </h2>
          {upcoming.length === 0 ? (
            <EmptyState icon={Package} title="未来 7 天没有到期项" description="到期中心会跟踪订阅、账单、证件等" />
          ) : (
            <ul className="space-y-2">
              {upcoming.slice(0, 8).map((it) => (
                <li key={it.id} className="flex items-center gap-2 text-sm">
                  <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-xs shrink-0">{it.kind || '到期'}</span>
                  <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{it.title}</span>
                  {it.expires_at && <span className="text-xs text-slate-400 shrink-0">{it.expires_at}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 目标进度 */}
        {activeGoals.length > 0 && (
          <section className="glass-panel rounded-3xl p-5" aria-label="目标进度">
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
              <Target size={14} aria-hidden /> 进行中的目标
            </h2>
            <ul className="space-y-2.5">
              {activeGoals.slice(0, 5).map((g) => {
                const done = g.milestones?.filter((m) => m.completed).length ?? 0;
                const total = g.milestones?.length ?? 0;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                return (
                  <li key={g.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{g.title}</span>
                      <span className="text-xs text-slate-400">{done}/{total}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mt-1">
                      <div className="h-full rounded-full bg-primary-500" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

export default WeeklyReview;
