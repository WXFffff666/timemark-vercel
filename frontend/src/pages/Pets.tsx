import { useCallback, useEffect, useState } from 'react';
import { Cat, Loader2, Plus, Syringe, Trash2, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.34 R14（审计 D3）：宠物页——pets 路由（宠物 + 疫苗/驱虫日程 + 提醒窗口）
 * 此前只有 API。日程完成走 POST complete（one-shot 自动退休，循环日程按间隔滚下期）。
 */

interface Pet {
  id: number;
  name: string;
  species: string;
  breed: string;
  ageDisplay: string | null;
  latestWeightKg: number | null;
}

interface PetSchedule {
  id: number;
  petId?: number;
  petName?: string;
  kind: string;
  name: string;
  dueDate: string;
  intervalDays: number | null;
  status?: string;
}

interface PetLog {
  id: number;
  kind: 'weight' | 'feeding' | 'vet';
  loggedAt: string;
  weightKg: number | null;
  detail: string;
}

interface PetWeightTrend {
  petId: number;
  trend: {
    points: Array<{ at: string; value: number; unit: string | null }>;
    count: number;
    latest: { at: string; value: number; unit: string | null } | null;
    delta: number | null;
    min: number | null;
    max: number | null;
    average: number | null;
    direction: 'rising' | 'falling' | 'stable' | 'none';
  };
}

interface PetReminder {
  scheduleId?: number;
  petName?: string;
  name?: string;
  dueDate?: string;
  daysUntil?: number;
}

// v2.35 R18（审计 #7）：后端 zod 枚举只有 vaccination|deworming——美容/其他此前必 400
const KIND_LABELS: Record<string, string> = { vaccination: '疫苗', deworming: '驱虫' };

const today = () => new Date().toISOString().slice(0, 10);

export default function Pets() {
  const [pets, setPets] = useState<Pet[]>([]);
  const [reminders, setReminders] = useState<PetReminder[]>([]);
  const [schedules, setSchedules] = useState<Record<number, PetSchedule[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // 加宠物表单
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [adding, setAdding] = useState(false);

  // 日程表单（按宠物）
  const [schedFor, setSchedFor] = useState<number | null>(null);
  const [schedKind, setSchedKind] = useState('vaccination');
  const [schedName, setSchedName] = useState('');
  const [schedDue, setSchedDue] = useState(today());
  // v2.35 R18（审计 #8）：循环间隔——完成一枚循环日程后自动滚下期
  const [schedInterval, setSchedInterval] = useState('');
  // v2.37 R24（审计 #6 遗留）：体重/喂养/就医记录与体重趋势
  const [logsFor, setLogsFor] = useState<number | null>(null);
  const [logs, setLogs] = useState<Record<number, PetLog[]>>({});
  const [weightTrend, setWeightTrend] = useState<Record<number, PetWeightTrend['trend'] | null>>({});
  const [logKind, setLogKind] = useState('weight');
  const [logWeight, setLogWeight] = useState('');
  const [logDetail, setLogDetail] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<{ pets: Pet[] }>('/pets'),
      api.get<{ reminders: PetReminder[] }>('/pets/reminders?days=30').catch(() => ({ reminders: [] })),
    ])
      .then(([p, r]) => {
        setPets(p.pets ?? []);
        setReminders(r.reminders ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadSchedules = useCallback(async (petId: number) => {
    try {
      const d = await api.get<{ data?: PetSchedule[] }>(`/pets/${petId}/schedules`);
      const list = (d as unknown as { data?: PetSchedule[] }).data ?? (d as unknown as PetSchedule[]);
      setSchedules((prev) => ({ ...prev, [petId]: Array.isArray(list) ? list : [] }));
    } catch {
      setSchedules((prev) => ({ ...prev, [petId]: [] }));
    }
  }, []);

  const toggleSchedules = (petId: number) => {
    if (schedules[petId] === undefined) void loadSchedules(petId);
    else setSchedules((prev) => {
      const next = { ...prev };
      delete next[petId];
      return next;
    });
  };

  const addPet = async () => {
    if (!name.trim()) {
      setError('请填写名字');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await api.post('/pets', { name: name.trim(), species: species.trim() || undefined });
      setName('');
      setSpecies('');
      setShowAdd(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const removePet = async (id: number, petName: string) => {
    if (!confirm(`删除「${petName}」会一并删除其日程与记录，确定？`)) return;
    try {
      await api.delete(`/pets/${id}`);
      setPets((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const addSchedule = async (petId: number) => {
    if (!schedName.trim()) {
      setError('请填写日程名称');
      return;
    }
    setBusyKey(`s-${petId}`);
    setError('');
    try {
      await api.post(`/pets/${petId}/schedules`, {
        kind: schedKind,
        name: schedName.trim(),
        dueDate: schedDue,
        ...(schedInterval.trim() && Number.isInteger(Number(schedInterval)) && Number(schedInterval) > 0
          ? { intervalDays: Number(schedInterval) }
          : {}),
      });
      setSchedName('');
      setSchedFor(null);
      void loadSchedules(petId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setBusyKey(null);
    }
  };

  const completeSchedule = async (petId: number, scheduleId: number) => {
    setBusyKey(`c-${scheduleId}`);
    try {
      await api.post(`/pets/${petId}/schedules/${scheduleId}/complete`, {});
      void loadSchedules(petId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusyKey(null);
    }
  };

  const loadLogs = useCallback(async (petId: number) => {
    try {
      const d = await api.get<{ data?: PetLog[] }>(`/pets/${petId}/logs?limit=20`);
      const list = (d as unknown as { events?: PetLog[] }).events ?? (d as unknown as PetLog[]) ?? [];
      setLogs((prev) => ({ ...prev, [petId]: Array.isArray(list) ? list : [] }));
    } catch {
      setLogs((prev) => ({ ...prev, [petId]: [] }));
    }
    try {
      const w = await api.get<{ data?: PetWeightTrend }>(`/pets/${petId}/weight`);
      const inner = (w as unknown as { data?: PetWeightTrend }).data ?? (w as unknown as PetWeightTrend);
      setWeightTrend((prev) => ({ ...prev, [petId]: inner?.trend ?? null }));
    } catch {
      setWeightTrend((prev) => ({ ...prev, [petId]: null }));
    }
  }, []);

  const addLog = async (petId: number) => {
    const weight = logKind === 'weight' ? Number(logWeight) : null;
    if (logKind === 'weight' && (!logWeight || !Number.isFinite(weight) || (weight as number) <= 0)) {
      setError('体重必须是有效数字（kg）');
      return;
    }
    setBusyKey(`log-${petId}`);
    setError('');
    try {
      await api.post(`/pets/${petId}/logs`, {
        kind: logKind,
        ...(logKind === 'weight' && weight !== null ? { weightKg: weight } : {}),
        ...(logDetail.trim() ? { detail: logDetail.trim() } : {}),
      });
      setLogWeight('');
      setLogDetail('');
      void loadLogs(petId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteLog = async (petId: number, logId: number) => {
    if (!confirm('删除这条记录？')) return;
    setBusyKey(`pl-${logId}`);
    try {
      await api.delete(`/pets/${petId}/logs/${logId}`);
      void loadLogs(petId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteSchedule = async (petId: number, scheduleId: number) => {
    if (!confirm('确定删除该日程？')) return;
    setBusyKey(`d-${scheduleId}`);
    try {
      await api.delete(`/pets/${petId}/schedules/${scheduleId}`);
      void loadSchedules(petId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="宠物"
        subtitle="毛孩子档案 · 疫苗/驱虫日程 · 到期提醒"
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

        {/* 30 天日程提醒速览 */}
        {reminders.length > 0 && (
          <section aria-label="日程提醒" className="glass-panel rounded-3xl p-4">
            <h2 className="text-sm font-bold text-hint mb-2 flex items-center gap-1.5">
              <Syringe size={14} aria-hidden /> 未来 30 天日程
            </h2>
            <ul className="space-y-1 text-sm">
              {reminders.slice(0, 6).map((r, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Badge variant={Number(r.daysUntil) <= 7 ? 'destructive' : 'secondary'} className="scale-90 shrink-0">
                    {r.dueDate}
                  </Badge>
                  <span className="truncate">{r.petName} · {r.name}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex justify-end">
          <Button onClick={() => setShowAdd((v) => !v)} aria-label="添加宠物">
            {showAdd ? null : <Plus className="w-4 h-4 mr-1" aria-hidden />}
            {showAdd ? '收起' : '添加宠物'}
          </Button>
        </div>

        {showAdd && (
          <div className="glass-panel rounded-3xl p-4 flex flex-wrap gap-2 items-end">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字（必填）" aria-label="宠物名字" className="w-32" />
            <Input value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="种类（猫/狗…）" aria-label="种类" className="w-32" />
            <Button onClick={() => void addPet()} disabled={adding} aria-label="保存宠物">
              {adding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
              保存
            </Button>
          </div>
        )}

        {loading ? (
          <SkeletonCard count={3} />
        ) : pets.length === 0 ? (
          <EmptyState icon={Cat} title="还没有添加宠物" description="添加毛孩子，跟踪疫苗/驱虫日程不漏针" />
        ) : (
          <ul className="space-y-4">
            {pets.map((p) => {
              const list = schedules[p.id];
              return (
                <li key={p.id} className="glass-panel rounded-3xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300 shrink-0" aria-hidden>
                        <Cat size={22} />
                      </span>
                      <div className="min-w-0">
                        <h2 className="font-bold text-slate-900 dark:text-white truncate">{p.name}</h2>
                        <p className="text-xs text-slate-400">
                          {[p.species, p.breed].filter(Boolean).join(' · ') || '—'}
                          {p.ageDisplay ? ` · ${p.ageDisplay}` : ''}
                          {p.latestWeightKg !== null ? ` · ${p.latestWeightKg}kg` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="rounded-full" onClick={() => toggleSchedules(p.id)} aria-expanded={!!list}>
                        <Syringe size={14} className="mr-1" aria-hidden /> 日程
                      </Button>
                      <Button size="sm" variant="outline" className="rounded-full" aria-expanded={logsFor === p.id} onClick={() => { setLogsFor(logsFor === p.id ? null : p.id); void loadLogs(p.id); }}>
                        体重/就医
                      </Button>
                      <Button size="icon" variant="ghost" className="min-h-9 min-w-9 text-red-500" aria-label={`删除 ${p.name}`} onClick={() => void removePet(p.id, p.name)}>
                        <Trash2 size={15} aria-hidden />
                      </Button>
                    </div>
                  </div>

                  {list && (
                    <div className="space-y-3 border-t border-slate-200/60 dark:border-slate-700/50 pt-4">
                      {schedFor === p.id ? (
                        <div className="flex flex-wrap gap-2 items-end">
                          <select value={schedKind} onChange={(e) => setSchedKind(e.target.value)} aria-label="日程类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                            {Object.entries(KIND_LABELS).map(([v, label]) => (
                              <option key={v} value={v}>{label}</option>
                            ))}
                          </select>
                          <Input value={schedName} onChange={(e) => setSchedName(e.target.value)} placeholder="名称（如 狂犬疫苗第 2 针）" aria-label="日程名称" className="flex-1 min-w-[10rem]" />
                          <Input type="date" value={schedDue} onChange={(e) => setSchedDue(e.target.value)} aria-label="到期日期" className="w-36" />
                          <Input value={schedInterval} onChange={(e) => setSchedInterval(e.target.value)} placeholder="每隔 N 天（可选）" aria-label="重复间隔天数" inputMode="numeric" className="w-36" />
                          <Button size="sm" onClick={() => void addSchedule(p.id)} disabled={busyKey === `s-${p.id}`} aria-label="保存日程">保存</Button>
                          <Button size="sm" variant="ghost" onClick={() => setSchedFor(null)} aria-label="取消日程">取消</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="rounded-full" onClick={() => { setSchedFor(p.id); }}>
                          <Plus size={14} className="mr-1" aria-hidden /> 加日程
                        </Button>
                      )}

                      {list.length === 0 ? (
                        <p className="text-xs text-slate-400">暂无日程——建议先建疫苗/驱虫计划</p>
                      ) : (
                        <ul className="space-y-1.5 text-sm" aria-label="日程列表">
                          {list.map((s) => {
                            const overdue = s.dueDate < today();
                            return (
                              <li key={s.id} className="flex items-center gap-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
                                <Badge variant="outline" className="scale-90 shrink-0">{KIND_LABELS[s.kind] ?? s.kind}</Badge>
                                <span className={`truncate ${overdue ? 'text-red-500 font-medium' : ''}`}>{s.name}</span>
                                <span className={`tabular-nums text-xs ml-auto shrink-0 ${overdue ? 'text-red-500' : 'text-slate-400'}`}>
                                  {s.dueDate}{overdue ? ' 已到期' : ''}
                                </span>
                                <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-emerald-600" aria-label={`完成「${s.name}」`} disabled={busyKey === `c-${s.id}`} onClick={() => void completeSchedule(p.id, s.id)}>
                                  <CheckCircle2 size={16} aria-hidden />
                                </Button>
                                <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-red-500" aria-label={`删除「${s.name}」`} disabled={busyKey === `d-${s.id}`} onClick={() => void deleteSchedule(p.id, s.id)}>
                                  <Trash2 size={14} aria-hidden />
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}

                  {logsFor === p.id && (
                    <div className="space-y-3 border-t border-slate-200/60 dark:border-slate-700/50 pt-4">
                      {(() => {
                        const t = weightTrend[p.id];
                        if (!t || t.count === 0) return null;
                        return (
                          <div className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3 text-xs">
                            <p className="text-slate-500 dark:text-slate-400 mb-1">
                              体重趋势（{t.count} 次记录）
                              {t.direction !== 'none' && <span className={`ml-2 font-bold ${t.direction === 'rising' ? 'text-red-500' : t.direction === 'falling' ? 'text-emerald-500' : 'text-slate-400'}`}>{t.direction === 'rising' ? '↗ 上升' : t.direction === 'falling' ? '↘ 下降' : '→ 平稳'}</span>}
                            </p>
                            <p className="tabular-nums text-slate-700 dark:text-slate-200">
                              最新 {t.latest?.value}{t.latest?.unit ?? 'kg'}
                              {t.delta !== null ? ` · 变化 ${t.delta > 0 ? '+' : ''}${t.delta.toFixed(2)}kg` : ''}
                              {t.average !== null ? ` · 均值 ${t.average.toFixed(2)}kg` : ''}
                            </p>
                          </div>
                        );
                      })()}

                      <div className="flex flex-wrap gap-2 items-end">
                        <select value={logKind} onChange={(e) => setLogKind(e.target.value)} aria-label="记录类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                          <option value="weight">体重</option>
                          <option value="feeding">喂养</option>
                          <option value="vet">就医</option>
                        </select>
                        {logKind === 'weight' && (
                          <Input value={logWeight} onChange={(e) => setLogWeight(e.target.value)} placeholder="体重 kg" aria-label="体重 kg" inputMode="decimal" className="w-24" />
                        )}
                        <Input value={logDetail} onChange={(e) => setLogDetail(e.target.value)} placeholder={logKind === 'vet' ? '就医详情（如 疫苗复诊）' : '详情（可选）'} aria-label="记录详情" className="flex-1 min-w-[10rem]" />
                        <Button size="sm" onClick={() => void addLog(p.id)} disabled={busyKey === `log-${p.id}`} aria-label="保存记录">保存</Button>
                      </div>

                      {(logs[p.id] ?? []).length > 0 && (
                        <ul className="space-y-1 text-xs" aria-label="照护记录">
                          {(logs[p.id] ?? []).map((l) => (
                            <li key={l.id} className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-1.5">
                              <Badge variant="outline" className="scale-90 shrink-0">{l.kind === 'weight' ? '体重' : l.kind === 'feeding' ? '喂养' : '就医'}</Badge>
                              <span className="tabular-nums text-slate-500 shrink-0">{new Date(l.loggedAt).toLocaleDateString('zh-CN')}</span>
                              {l.weightKg !== null && <span className="tabular-nums font-semibold">{l.weightKg}kg</span>}
                              {l.detail && <span className="truncate text-slate-500">{l.detail}</span>}
                              <Button size="icon" variant="ghost" className="min-h-6 min-w-6 text-red-400 hover:text-red-500 ml-auto shrink-0" aria-label="删除记录" onClick={() => void deleteLog(p.id, l.id)}>
                                <Trash2 size={12} aria-hidden />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
