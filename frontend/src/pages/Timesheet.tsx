import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, LogOut, Loader2, Timer } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.32 R11（审计 D3）：工时页——timesheet 路由此前零 UI。
 * 上班打卡/下班签退 → 本周汇总（天数/时长/日均）+ 加班视图（超阈值天数）。
 */

interface Session {
  id: number;
  clockIn: string;
  clockOut: string | null;
  note: string;
  location: string;
  durationMinutes: number | null;
  open: boolean;
}

interface OvertimeView {
  thresholdMinutes: number;
  totalOvertimeMinutes: number;
  days: Array<{ date: string; workedMinutes: number; overtimeMinutes: number }>;
  defaultThresholdMinutes: number;
  from: string;
  to: string;
}

const fmtMin = (m: number): string => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
const fmtTime = (iso: string): string => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function Timesheet() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [openSession, setOpenSession] = useState<Session | null>(null);
  const [overtime, setOvertime] = useState<OvertimeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<{ sessions: Session[]; openSession: Session | null }>('/timesheet/sessions'),
      api.get<OvertimeView>('/timesheet/overtime'),
    ])
      .then(([s, o]) => {
        setSessions(s.sessions ?? []);
        setOpenSession(s.openSession ?? null);
        setOvertime(o ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clockIn = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/timesheet/sessions/clock-in', note.trim() ? { note: note.trim() } : {});
      setNote('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '打卡失败');
    } finally {
      setBusy(false);
    }
  };

  const clockOut = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/timesheet/sessions/clock-out', {});
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '签退失败');
    } finally {
      setBusy(false);
    }
  };

  const weekSummary = useMemo(() => {
    if (!overtime) return null;
    const days = overtime.days ?? [];
    const totalWorked = days.reduce((sum, d) => sum + d.workedMinutes, 0);
    const dayCount = days.filter((d) => d.workedMinutes > 0).length;
    return { totalWorked, dayCount, overtime: overtime.totalOvertimeMinutes };
  }, [overtime]);

  const recent = useMemo(() => sessions.slice(0, 10), [sessions]);

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="工时"
        subtitle="上班打卡 · 下班签退 · 本周汇总与加班"
        back="smart"
        onRefresh={load}
        refreshing={loading}
      />

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {error && (
          <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}

        {/* 打卡卡 */}
        <div className="glass-panel rounded-3xl p-6 text-center space-y-4">
          {openSession ? (
            <>
              <Badge variant="default" className="scale-105">
                <Clock size={12} className="mr-1" aria-hidden /> 进行中 · 自 {fmtTime(openSession.clockIn)}
              </Badge>
              <div>
                <Button size="lg" variant="destructive" className="rounded-full min-h-12 px-8" disabled={busy} onClick={() => void clockOut()} aria-label="下班签退">
                  {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <LogOut className="w-5 h-5 mr-2" aria-hidden />}
                  下班签退
                </Button>
              </div>
            </>
          ) : (
            <>
              <Badge variant="outline">未打卡</Badge>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="备注（可选：地点/今日重点）"
                aria-label="打卡备注"
                maxLength={120}
              />
              <div>
                <Button size="lg" variant="vision" className="rounded-full min-h-12 px-10" disabled={busy} onClick={() => void clockIn()} aria-label="上班打卡">
                  {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <Clock className="w-5 h-5 mr-2" aria-hidden />}
                  上班打卡
                </Button>
              </div>
            </>
          )}
        </div>

        {/* 本周汇总 + 加班 */}
        {weekSummary && weekSummary.dayCount > 0 && (
          <div className="grid grid-cols-3 gap-3">
            <div className="glass-panel rounded-2xl p-4 text-center">
              <p className="text-xs text-hint">本周出勤</p>
              <p className="text-2xl font-extrabold text-slate-900 dark:text-white tabular-nums">{weekSummary.dayCount}<span className="text-sm font-medium text-hint"> 天</span></p>
            </div>
            <div className="glass-panel rounded-2xl p-4 text-center">
              <p className="text-xs text-hint">本周工时</p>
              <p className="text-2xl font-extrabold text-slate-900 dark:text-white tabular-nums">{fmtMin(weekSummary.totalWorked)}</p>
            </div>
            <div className="glass-panel rounded-2xl p-4 text-center">
              <p className="text-xs text-hint">本周加班</p>
              <p className={`text-2xl font-extrabold tabular-nums ${weekSummary.overtime > 0 ? 'text-orange-500' : 'text-slate-900 dark:text-white'}`}>{fmtMin(weekSummary.overtime)}</p>
            </div>
          </div>
        )}

        {/* 加班日明细 */}
        {overtime && overtime.days.some((d) => d.overtimeMinutes > 0) && (
          <section aria-label="加班明细">
            <h2 className="text-sm font-bold text-hint mb-2 px-1">加班明细（阈值 {fmtMin(overtime.thresholdMinutes)}/天）</h2>
            <ul className="space-y-1.5">
              {overtime.days.filter((d) => d.overtimeMinutes > 0).map((d) => (
                <li key={d.date} className="glass-panel rounded-xl px-4 py-2 text-sm flex items-center gap-3">
                  <span className="tabular-nums text-slate-500 shrink-0">{d.date}</span>
                  <span className="tabular-nums">实工 {fmtMin(d.workedMinutes)}</span>
                  <span className="tabular-nums text-orange-500 ml-auto">+{fmtMin(d.overtimeMinutes)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 最近记录 */}
        <section aria-label="最近记录">
          <h2 className="text-sm font-bold text-hint mb-2 px-1">最近记录</h2>
          {loading ? (
            <SkeletonCard count={3} />
          ) : recent.length === 0 ? (
            <EmptyState icon={Timer} title="还没有打卡记录" description="点上方「上班打卡」开始记录工时" />
          ) : (
            <ul className="space-y-1.5">
              {recent.map((s) => (
                <li key={s.id} className="glass-panel rounded-xl px-4 py-2.5 text-sm flex items-center gap-3">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.open ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} aria-hidden />
                  <span className="tabular-nums text-slate-600 dark:text-slate-300 shrink-0">{fmtTime(s.clockIn)}</span>
                  <span className="text-slate-400">→</span>
                  <span className="tabular-nums text-slate-600 dark:text-slate-300 shrink-0">{s.clockOut ? fmtTime(s.clockOut) : '进行中'}</span>
                  {s.durationMinutes !== null && <span className="tabular-nums text-slate-500 ml-auto shrink-0">{fmtMin(s.durationMinutes)}</span>}
                  {s.note && <span className="text-xs text-slate-400 truncate hidden sm:block">{s.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
