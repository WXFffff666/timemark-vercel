import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, LogOut, Loader2, Timer, CalendarOff, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { useConfirm } from '@/components/ui/confirm-dialog';
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
  // v2.40 R18：统一确认弹窗（Promise 化 confirm，遮蔽全局同名函数）
  const { confirm, confirmDialog } = useConfirm();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [openSession, setOpenSession] = useState<Session | null>(null);
  const [overtime, setOvertime] = useState<OvertimeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 逐操作 busy 键（null=空闲）：打卡/签退用全局 busy，行级操作（删打卡、补签退、请假）用键控
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // v2.34 R15（审计 #11）：location 此前未采集（后端早就支持）
  const [location, setLocation] = useState('');
  // v2.36 R22（审计 #2）：请假区块——/timesheet/leaves 此前零 UI
  const [leaves, setLeaves] = useState<Array<{ id: number; kind: string; startDate: string; endDate: string; days: number; note: string }>>([]);
  const [leaveKind, setLeaveKind] = useState('leave');
  const [leaveFrom, setLeaveFrom] = useState('');
  const [leaveTo, setLeaveTo] = useState('');
  const [showLeaves, setShowLeaves] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<{ sessions: Session[]; openSession: Session | null }>('/timesheet/sessions'),
      api.get<OvertimeView>('/timesheet/overtime'),
      api.get<{ leaves: Array<{ id: number; kind: string; startDate: string; endDate: string; days: number; note: string }> }>('/timesheet/leaves').catch(() => ({ leaves: [] })),
    ])
      .then(([s, o, l]) => {
        setSessions(s.sessions ?? []);
        setOpenSession(s.openSession ?? null);
        setOvertime(o ?? null);
        setLeaves(l.leaves ?? []);
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
      await api.post('/timesheet/sessions/clock-in', {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
      });
      setNote('');
      setLocation('');
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

  // v2.35 R18（审计 #1）：误打卡修正——补签退/删除（否则忘签退的会话永久「进行中」并令下次打卡 409 死锁）
  const backfillClockOut = async (session: Session) => {
    const raw = prompt(`为「${fmtTime(session.clockIn)}」的打卡补签退时间（HH:mm，24 小时制）`, '18:00');
    if (raw === null) return;
    if (!/^\d{2}:\d{2}$/.test(raw.trim())) {
      setError('时间格式需为 HH:mm');
      return;
    }
    setBusyKey(`bf-${session.id}`);
    setError('');
    try {
      // 后端 timestamp 校验接受 ISO；把 HH:mm 拼到打卡当天
      const day = session.clockIn.slice(0, 10);
      await api.patch(`/timesheet/sessions/${session.id}`, { clockOut: `${day}T${raw.trim()}:00` });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '补签退失败');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteSession = async (session: Session) => {
    if (!(await confirm({ title: `删除 ${fmtTime(session.clockIn)} 的打卡记录？`, tone: 'danger', confirmLabel: '删除' }))) return;
    setBusyKey(`del-${session.id}`);
    setError('');
    try {
      await api.delete(`/timesheet/sessions/${session.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  };

  const addLeave = async () => {
    if (!leaveFrom || !leaveTo) {
      setError('请选择请假起止日期');
      return;
    }
    setBusyKey('leave-add');
    setError('');
    try {
      await api.post('/timesheet/leaves', { kind: leaveKind, startDate: leaveFrom, endDate: leaveTo });
      setLeaveFrom('');
      setLeaveTo('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '请假记录失败');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteLeave = async (id: number) => {
    if (!(await confirm({ title: '删除这条请假记录？', tone: 'danger', confirmLabel: '删除' }))) return;
    setBusyKey(`lv-${id}`);
    try {
      await api.delete(`/timesheet/leaves/${id}`);
      setLeaves((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  };

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
                placeholder="备注（可选：今日重点）"
                aria-label="打卡备注"
                maxLength={120}
              />
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="地点（可选，如 公司/家里）"
                aria-label="打卡地点"
                maxLength={80}
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

        {/* v2.36 R22（审计 #2）：请假区块 */}
        <section aria-label="请假记录" className="glass-panel rounded-3xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-hint flex items-center gap-1.5">
              <CalendarOff size={16} aria-hidden /> 请假 / 缺勤
            </h2>
            <Button size="sm" variant="ghost" className="rounded-full text-xs" onClick={() => setShowLeaves((v) => !v)}>
              {showLeaves ? '收起' : '记请假'}
            </Button>
          </div>
          {showLeaves && (
            <div className="flex flex-wrap gap-2 items-end">
              <select value={leaveKind} onChange={(e) => setLeaveKind(e.target.value)} aria-label="请假类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                <option value="leave">事假</option>
                <option value="sick">病假</option>
                <option value="absence">缺勤</option>
                <option value="holiday">假日</option>
                <option value="other">其他</option>
              </select>
              <Input type="date" value={leaveFrom} onChange={(e) => setLeaveFrom(e.target.value)} aria-label="请假开始日期" className="w-36" />
              <Input type="date" value={leaveTo} onChange={(e) => setLeaveTo(e.target.value)} aria-label="请假结束日期" className="w-36" />
              <Button size="sm" onClick={() => void addLeave()} disabled={busyKey === 'leave-add'} aria-label="保存请假">保存</Button>
            </div>
          )}
          {leaves.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {leaves.slice(0, 8).map((l) => (
                <li key={l.id} className="flex items-center gap-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
                  <Badge variant="outline" className="scale-90 shrink-0">{l.kind}</Badge>
                  <span className="tabular-nums">{l.startDate} ~ {l.endDate}</span>
                  <span className="text-slate-400 text-xs shrink-0">{l.days} 天</span>
                  <Button size="icon" variant="ghost" className="min-h-7 min-w-7 text-red-400 ml-auto shrink-0" aria-label="删除请假记录" onClick={() => void deleteLeave(l.id)}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-400">暂无请假记录</p>
          )}
        </section>

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
                  {s.durationMinutes !== null && <span className="tabular-nums text-slate-500 shrink-0">{fmtMin(s.durationMinutes)}</span>}
                  {s.location && <span className="text-xs text-slate-400 shrink-0">📍 {s.location}</span>}
                  {s.note && <span className="text-xs text-slate-400 truncate hidden sm:block">{s.note}</span>}
                  <div className="flex gap-1 shrink-0 ml-auto">
                    {s.open && (
                      <Button size="sm" variant="outline" className="rounded-full h-7 px-2 text-xs" disabled={busyKey !== null} onClick={() => void backfillClockOut(s)}>
                        补签退
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-red-400 hover:text-red-500" aria-label={`删除 ${fmtTime(s.clockIn)} 的打卡`} disabled={busyKey !== null} onClick={() => void deleteSession(s)}>
                      {busyKey === `del-${s.id}` ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Trash2 size={13} aria-hidden />}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      {confirmDialog}
    </div>
  );
}
