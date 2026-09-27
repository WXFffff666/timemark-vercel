import { useMemo } from 'react';
import { getAlmanac } from '@/lib/almanac';

/**
 * 今日黄历 / 节气 / 生肖 / 星座 card (plan todo 77).
 *
 * `compact` renders on /dashboard; `detail` renders inside the /calendar day
 * panel (adds 值星, 冲煞 and 吉神方位). Any library gap degrades to a partial
 * card with a subtle 数据不完整 hint instead of crashing the page.
 */

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate" title={value ?? undefined}>
        {value || '—'}
      </p>
    </div>
  );
}

function TagList({ items, tone, limit }: { items: string[]; tone: 'good' | 'bad'; limit: number }) {
  const palette =
    tone === 'good'
      ? 'bg-emerald-100/80 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'bg-rose-100/80 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300';
  if (items.length === 0) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {items.slice(0, limit).map((item) => (
        <span key={item} className={`rounded px-1.5 py-0.5 text-[10px] ${palette}`}>
          {item}
        </span>
      ))}
      {items.length > limit && <span className="text-[10px] text-slate-400">+{items.length - limit}</span>}
    </span>
  );
}

export function AlmanacCard({ dateKey, variant = 'compact' }: { dateKey?: string; variant?: 'compact' | 'detail' }) {
  const data = useMemo(() => getAlmanac(dateKey ?? new Date()), [dateKey]);
  const ganZhi = [data.ganZhi.year, data.ganZhi.month, data.ganZhi.day].filter(Boolean).join(' ') || null;
  const tagLimit = variant === 'detail' ? 12 : 4;

  return (
    <section
      className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10"
      data-testid="almanac-card"
      aria-label="今日黄历"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200">今日黄历</h2>
        <span className="text-[10px] text-slate-400" data-testid="almanac-date">
          {data.date}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
        <Field label="农历" value={data.lunarText} />
        <Field label="干支" value={ganZhi} />
        <Field label="生肖" value={data.zodiac} />
        <Field label="星座" value={data.constellation} />
      </div>

      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300" data-testid="almanac-jieqi">
        {data.isJieQi && data.jieQi
          ? `今日节气：${data.jieQi}`
          : data.nextJieQi
            ? `下个节气：${data.nextJieQi.name} · ${data.nextJieQi.date}`
            : '节气：—'}
      </p>

      <div className="mt-2 space-y-1">
        <div className="flex items-start gap-2" data-testid="almanac-yi">
          <span className="shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">宜</span>
          <TagList items={data.yi} tone="good" limit={tagLimit} />
        </div>
        <div className="flex items-start gap-2" data-testid="almanac-ji">
          <span className="shrink-0 text-[10px] font-bold text-rose-600 dark:text-rose-400 mt-0.5">忌</span>
          <TagList items={data.ji} tone="bad" limit={tagLimit} />
        </div>
      </div>

      {variant === 'detail' && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 border-t border-slate-200/60 dark:border-slate-700/60 pt-2">
          <Field label="值星" value={data.zhiXing} />
          <Field label="冲煞" value={[data.chong, data.sha && `煞${data.sha}`].filter(Boolean).join(' · ') || null} />
          <Field
            label="吉神方位"
            value={data.positions.map((position) => `${position.name}${position.direction ?? '—'}`).join(' ') || null}
          />
        </div>
      )}

      {data.incompleteFields.length > 0 && (
        <p className="mt-2 text-[10px] text-slate-400" data-testid="almanac-incomplete">
          数据不完整（{data.incompleteFields.join('、')} 暂缺）
        </p>
      )}
    </section>
  );
}
