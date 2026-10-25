import { useCallback, useEffect, useState } from 'react';
import { HeartHandshake, Loader2, Plus, Trash2, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.35 R17（审计 D3 最后一个大模块）：照护页——care 路由此前零 UI。
 * 档案（家人/被照护者）+ 照护事件流（喂养/用药/体征/情绪/意外）+ 可打印日结。
 */

interface CareProfile {
  id: number;
  name: string;
  relationship: string;
  dateOfBirth: string | null;
  allergies: string;
  notes: string;
}

interface CareLog {
  id: number;
  kind: string;
  label: string | null;
  value: number | null;
  unit: string | null;
  detail: string;
  loggedAt: string;
}

const KIND_LABELS: Record<string, string> = {
  feeding: '喂养',
  dose: '用药',
  vitals: '体征',
  mood: '情绪',
  incident: '意外',
};

// v2.35 R19/v2.36 R21（审计 #6 遗留）：数值标签的趋势视图
interface TrendData {
  label: string | null;
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

function TrendBlock({ profileId, label, onRemove }: { profileId: number; label: string; onRemove: () => void }) {
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api
      .get<TrendData>(`/care/profiles/${profileId}/trend?label=${encodeURIComponent(label)}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setLoading(false); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [profileId, label]);

  const t = data?.trend;
  const dirIcon = t?.direction === 'rising' ? '↗' : t?.direction === 'falling' ? '↘' : '→';
  const dirColor = t?.direction === 'rising' ? 'text-red-500' : t?.direction === 'falling' ? 'text-emerald-500' : 'text-slate-400';

  return (
    <div className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{label}</span>
        {loading ? (
          <Loader2 size={14} className="animate-spin text-slate-400" aria-hidden />
        ) : t && t.direction !== 'none' ? (
          <span className={`text-sm font-bold ${dirColor}`} aria-label={`趋势 ${t.direction}`}>{dirIcon}</span>
        ) : null}
        <Button size="icon" variant="ghost" className="min-h-7 min-w-7 ml-auto text-slate-400" aria-label={`关闭「${label}」趋势`} onClick={onRemove}>
          ×
        </Button>
      </div>
      {t && t.count > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 text-xs">
          <span className="text-slate-500 dark:text-slate-400">最新 <strong className="text-slate-800 dark:text-slate-100 tabular-nums">{t.latest?.value}{t.latest?.unit ?? ''}</strong></span>
          <span className="text-slate-500 dark:text-slate-400">变化 <strong className={`tabular-nums ${(t.delta ?? 0) > 0 ? 'text-red-500' : (t.delta ?? 0) < 0 ? 'text-emerald-500' : ''}`}>{t.delta !== null ? (t.delta > 0 ? '+' : '') + t.delta.toFixed(1) : '—'}</strong></span>
          <span className="text-slate-500 dark:text-slate-400">范围 <strong className="tabular-nums text-slate-700 dark:text-slate-200">{t.min?.toFixed(1)}~{t.max?.toFixed(1)}</strong></span>
          <span className="text-slate-500 dark:text-slate-400">均值 <strong className="tabular-nums text-slate-700 dark:text-slate-200">{t.average?.toFixed(1)}</strong></span>
        </div>
      )}
      {t && t.count === 0 && <p className="text-xs text-slate-400 mt-1">该标签还没有带数值的记录</p>}
    </div>
  );
}

export default function Care() {
  const [profiles, setProfiles] = useState<CareProfile[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [logs, setLogs] = useState<CareLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 加档案表单
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [adding, setAdding] = useState(false);

  // 加日志表单（按档案）
  const [logFor, setLogFor] = useState<number | null>(null);
  const [logKind, setLogKind] = useState('feeding');
  const [logLabel, setLogLabel] = useState('');
  const [logValue, setLogValue] = useState('');
  const [logUnit, setLogUnit] = useState('');
  const [logDetail, setLogDetail] = useState('');
  // v2.36 R21（审计 #6 遗留）：数值标签趋势视图
  const [openTrends, setOpenTrends] = useState<Set<string>>(new Set());

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<CareProfile[]>('/care/profiles')
      .then((d) => {
        const list = Array.isArray(d) ? d : [];
        setProfiles(list);
        setSelectedId((prev) => (prev !== null && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadLogs = useCallback(async (profileId: number) => {
    setLogsLoading(true);
    try {
      const d = await api.get<{ events: CareLog[] }>(`/care/profiles/${profileId}/logs?limit=30`);
      setLogs(Array.isArray(d.events) ? d.events : []);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId !== null) void loadLogs(selectedId);
  }, [selectedId, loadLogs]);

  const addProfile = async () => {
    if (!name.trim()) {
      setError('请填写名字');
      return;
    }
    setAdding(true);
    setError('');
    try {
      const created = await api.post<{ id: number }>('/care/profiles', {
        name: name.trim(),
        relationship: relationship.trim() || undefined,
      });
      setName('');
      setRelationship('');
      setShowAdd(false);
      load();
      if (created?.id) setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const removeProfile = async (id: number, profileName: string) => {
    if (!confirm(`删除「${profileName}」会一并删除其照护记录，确定？`)) return;
    try {
      await api.delete(`/care/profiles/${id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const addLog = async () => {
    if (selectedId === null) return;
    const value = logValue.trim() === '' ? null : Number(logValue);
    if (logValue.trim() !== '' && (!Number.isFinite(value) || value === null)) {
      setError('数值必须是数字');
      return;
    }
    setBusyKey(`log-${selectedId}`);
    setError('');
    try {
      await api.post(`/care/profiles/${selectedId}/logs`, {
        kind: logKind,
        ...(logLabel.trim() ? { label: logLabel.trim() } : {}),
        ...(value !== null ? { value } : {}),
        ...(logUnit.trim() ? { unit: logUnit.trim() } : {}),
        ...(logDetail.trim() ? { detail: logDetail.trim() } : {}),
      });
      setLogLabel('');
      setLogValue('');
      setLogUnit('');
      setLogDetail('');
      void loadLogs(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteLog = async (logId: number) => {
    if (!confirm('删除这条照护记录？')) return;
    setBusyKey(`del-${logId}`);
    try {
      await api.delete(`/care/logs/${logId}`);
      if (selectedId !== null) void loadLogs(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  };

  const copyDailyLog = async () => {
    if (selectedId === null) return;
    setBusyKey(`dl-${selectedId}`);
    try {
      // format=text 返回纯文本（c.text），不是 JSON——用原生 fetch 取 text()
      const res = await fetch(
        `/api/care/profiles/${selectedId}/daily-log?date=${new Date().toISOString().slice(0, 10)}&format=text`,
        { credentials: 'include' },
      );
      const text = await res.text();
      if (res.ok && text.trim()) {
        navigator.clipboard.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        setError(res.ok ? '今日日结为空' : `获取日结失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取日结失败');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="照护"
        subtitle="家人档案 · 喂养/用药/体征记录 · 可打印日结"
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

        {/* 档案切换 chips */}
        <div className="flex flex-wrap gap-2 items-center">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={selectedId === p.id}
              onClick={() => setSelectedId(p.id)}
              className={`px-3 h-10 rounded-full border text-sm transition ${selectedId === p.id ? 'bg-primary-500 text-white border-primary-500 font-semibold' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            >
              {p.name}
              {p.relationship ? <span className="text-xs opacity-70"> · {p.relationship}</span> : null}
            </button>
          ))}
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setShowAdd((v) => !v)} aria-label="添加照护档案">
            <Plus size={14} className="mr-1" aria-hidden /> 添加档案
          </Button>
          {/* v2.39：removeProfile 此前是写了没接线的死函数——补上删除入口（当前选中档案） */}
          {selected && (
            <Button
              size="icon"
              variant="ghost"
              className="min-h-9 min-w-9 text-red-400 hover:text-red-500"
              aria-label={`删除档案 ${selected.name}`}
              onClick={() => void removeProfile(selected.id, selected.name)}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          )}
        </div>

        {showAdd && (
          <div className="glass-panel rounded-3xl p-4 flex flex-wrap gap-2 items-end">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字（必填）" aria-label="档案名字" className="w-32" />
            <Input value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="关系（如 奶奶）" aria-label="关系" className="w-32" />
            <Button onClick={() => void addProfile()} disabled={adding} aria-label="保存档案">
              {adding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
              保存
            </Button>
          </div>
        )}

        {loading ? (
          <SkeletonCard count={3} />
        ) : profiles.length === 0 ? (
          <EmptyState icon={HeartHandshake} title="还没有照护档案" description="为孩子/老人/病人建档案，记录每次喂养、用药与体征" />
        ) : selected ? (
          <div className="space-y-4">
            {/* 档案头 */}
            <div className="glass-panel rounded-3xl p-5 flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300 shrink-0" aria-hidden>
                  <HeartHandshake size={22} />
                </span>
                <div className="min-w-0">
                  <h2 className="font-bold text-slate-900 dark:text-white truncate">{selected.name}</h2>
                  <p className="text-xs text-slate-400">
                    {selected.allergies ? <Badge variant="destructive" className="mr-2 scale-90">过敏: {selected.allergies}</Badge> : null}
                    {selected.dateOfBirth || '—'}
                  </p>
                </div>
              </div>
              <Button size="sm" variant="outline" className="rounded-full" disabled={busyKey === `dl-${selected.id}`} onClick={() => void copyDailyLog()}>
                {busyKey === `dl-${selected.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Copy size={14} className="mr-1" aria-hidden />}
                {copied ? '已复制 ✓' : '复制今日日结'}
              </Button>
            </div>

            {/* 记录表单 */}
            {logFor === selected.id ? (
              <div className="glass-panel rounded-3xl p-4 space-y-3">
                <div className="flex flex-wrap gap-2 items-center">
                  <select value={logKind} onChange={(e) => setLogKind(e.target.value)} aria-label="照护类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                    {Object.entries(KIND_LABELS).map(([v, label]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                  <Input value={logLabel} onChange={(e) => setLogLabel(e.target.value)} placeholder="项目（如 奶粉/体温）" aria-label="项目" className="w-40" />
                  <Input value={logValue} onChange={(e) => setLogValue(e.target.value)} placeholder="数值（可选）" aria-label="数值" inputMode="decimal" className="w-28" />
                  <Input value={logUnit} onChange={(e) => setLogUnit(e.target.value)} placeholder="单位（可选）" aria-label="单位" className="w-24" />
                </div>
                <Input value={logDetail} onChange={(e) => setLogDetail(e.target.value)} placeholder="详情（可选）" aria-label="详情" maxLength={1000} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void addLog()} disabled={busyKey === `log-${selected.id}`} aria-label="保存照护记录">保存记录</Button>
                  <Button size="sm" variant="ghost" onClick={() => setLogFor(null)} aria-label="取消记录">取消</Button>
                </div>
              </div>
            ) : (
              <Button className="w-full" variant="outline" onClick={() => setLogFor(selected.id)} aria-label="记录一条照护事件">
                <Plus className="w-4 h-4 mr-1" aria-hidden /> 记录照护事件
              </Button>
            )}

            {/* 事件流 */}
            {logsLoading ? (
              <SkeletonCard count={3} />
            ) : logs.length === 0 ? (
              <EmptyState icon={HeartHandshake} title="暂无照护记录" description="用上方表单记录喂养、用药、体征与情绪" />
            ) : (
              <ul className="space-y-2" aria-label="照护事件流">
                {logs.map((log) => (
                  <li key={log.id} className="glass-panel rounded-2xl px-4 py-3 flex items-start gap-3">
                    <Badge variant="outline" className="scale-90 shrink-0">{KIND_LABELS[log.kind] ?? log.kind}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-800 dark:text-slate-100 truncate">
                        {log.label || KIND_LABELS[log.kind] || log.kind}
                        {log.value !== null && log.value !== undefined && (
                          <span className="text-primary-600 dark:text-primary-300 font-semibold"> {log.value}{log.unit ?? ''}</span>
                        )}
                      </p>
                      {log.detail && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 whitespace-pre-wrap">{log.detail}</p>}
                    </div>
                    <span className="text-xs text-slate-400 shrink-0 tabular-nums">{new Date(log.loggedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-red-500 shrink-0" aria-label={`删除「${log.label || log.kind}」记录`} disabled={busyKey === `del-${log.id}`} onClick={() => void deleteLog(log.id)}>
                      {busyKey === `del-${log.id}` ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {/* v2.36 R21：数值标签趋势（从当前日志派生 label） */}
            {selected && (() => {
              const labels = Array.from(new Set(logs.filter((l) => l.value !== null && l.value !== undefined && l.label).map((l) => l.label!)));
              if (labels.length === 0) return null;
              return (
                <section aria-label="数值趋势" className="space-y-2">
                  <h2 className="text-sm font-bold text-hint px-1">数值趋势</h2>
                  {labels.map((label) => (
                    <div key={label}>
                      {openTrends.has(label) ? (
                        <TrendBlock profileId={selected.id} label={label} onRemove={() => setOpenTrends((prev) => { const n = new Set(prev); n.delete(label); return n; })} />
                      ) : (
                        <button
                          type="button"
                          className="text-xs text-primary-600 dark:text-primary-400 hover:underline px-1"
                          onClick={() => setOpenTrends((prev) => new Set(prev).add(label))}
                        >
                          查看「{label}」趋势 →
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              );
            })()}
          </div>
        ) : null}
      </main>
    </div>
  );
}
