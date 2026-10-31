import { useEffect, useMemo, useState } from 'react';
import { Flame, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

/**
 * v2.42 R25：习惯坚持热力图——GitHub 式 26 周贡献网格（调研确认的 2026
 * 主导视觉隐喻）。数据 GET /habits/:id/logs?days=182（R25 新端点）。
 * 色阶按当日 count：0=空 / 1 / 2 / 3 / ≥4。
 */

type LogRow = { logged_on: string; count: number };
type HabitOption = { id: number; name: string; icon?: string | null; streak: { current: number; longest: number } };

const LEVEL_CLASS = [
  'bg-slate-100 dark:bg-slate-800',
  'bg-emerald-200 dark:bg-emerald-900',
  'bg-emerald-300 dark:bg-emerald-700',
  'bg-emerald-400 dark:bg-emerald-600',
  'bg-emerald-500 dark:bg-emerald-500',
];

function levelFor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function HabitHeatmap({ habits }: { habits: Array<HabitOption> }) {
  // v2.43 R27：26 周 / 52 周年视图切换（调研：年视图是 GitHub 式追踪器标配进阶）
  const [weeks, setWeeks] = useState<26 | 52>(26);
  const [habitId, setHabitId] = useState<number | null>(habits[0]?.id ?? null);
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (habitId === null) return;
    setLoading(true);
    api.get<LogRow[]>(`/habits/${habitId}/logs?days=${weeks === 52 ? 364 : 182}`)
      .then((rows) => setLogs(Array.isArray(rows) ? rows : []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [habitId, weeks]);

  // 网格：从本周一开始向前 weeks 列；行 = 周一..周日
  const cells = useMemo(() => {
    if (!logs) return null;
    const byDate = new Map(logs.map((l) => [l.logged_on, l.count]));
    const today = new Date();
    const day = (today.getDay() + 6) % 7; // 周一=0
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - day);
    const cols: Array<Array<{ ymd: string; count: number } | null>> = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const col: Array<{ ymd: string; count: number } | null> = [];
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - w * 7 + dow);
        const key = ymd(d);
        const future = key > ymd(today);
        col.push(future ? null : { ymd: key, count: byDate.get(key) ?? 0 });
      }
      cols.push(col);
    }
    return cols;
  }, [logs, weeks]);

  const selected = habits.find((h) => h.id === habitId) ?? null;
  const totalCheckins = logs?.reduce((s, l) => s + (l.count > 0 ? 1 : 0), 0) ?? 0;

  if (habits.length === 0) return null;

  return (
    <section className="glass-panel rounded-3xl p-5" aria-label="坚持热力图" data-testid="habit-heatmap">
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
        <Flame size={14} aria-hidden /> 坚持热力图
      </h2>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={habitId ?? ''}
          onChange={(e) => setHabitId(Number(e.target.value) || null)}
          aria-label="选择习惯"
          className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
        >
          {habits.map((h) => (
            <option key={h.id} value={h.id}>{h.icon ? `${h.icon} ` : ''}{h.name}</option>
          ))}
        </select>
        {/* v2.43 R27：26 周 / 52 周切换 */}
        <div className="flex gap-1" role="group" aria-label="时间范围">
          {([26, 52] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={weeks === w}
              onClick={() => setWeeks(w)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${weeks === w ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            >
              {w} 周
            </button>
          ))}
        </div>
        {selected && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            近 {weeks} 周 <strong className="text-slate-700 dark:text-slate-200">{totalCheckins}</strong> 天 · 连胜 {selected.streak.current} · 最长 {selected.streak.longest}
          </span>
        )}
      </div>
      {loading ? (
        <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> 加载打卡记录…</p>
      ) : cells === null ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <div className="overflow-x-auto pb-1">
          <div className="flex gap-[3px]" role="img" aria-label={`过去 ${weeks} 周打卡热力图`}>
            {cells.map((col, ci) => (
              <div key={ci} className="flex flex-col gap-[3px]">
                {col.map((cell, ri) =>
                  cell === null ? (
                    <span key={ri} className="w-[11px] h-[11px] rounded-[2px] bg-transparent" />
                  ) : (
                    <span
                      key={ri}
                      title={`${cell.ymd} · ${cell.count} 次`}
                      className={`w-[11px] h-[11px] rounded-[2px] ${LEVEL_CLASS[levelFor(cell.count)]}`}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-slate-400">
            <span>少</span>
            {LEVEL_CLASS.map((c, i) => <span key={i} className={`w-[10px] h-[10px] rounded-[2px] ${c}`} />)}
            <span>多</span>
          </div>
        </div>
      )}
    </section>
  );
}
