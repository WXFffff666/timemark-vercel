import { useMemo, useState } from 'react';
import {
  ALMANAC_PURPOSES,
  ALMANAC_WU_XING,
  formatAlmanacDateKey,
  getAlmanac,
  getBazi,
  getConstellationCompatibility,
  getRitualExtras,
  getZodiacCompatibility,
  searchAuspiciousDays,
  type AlmanacAuspiciousResult,
  type AlmanacBaziResult,
} from '@/lib/almanac';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * 传统历法进阶面板 (plan todo 150): 择日 / 八字五行 / 生肖·星座配对 /
 * 彭祖百忌·吉神方位. Every section is informational only — the page-level
 * disclaimer (`ALMANAC_DISCLAIMER`) is rendered as visible DOM text, never a
 * tooltip attribute, and nothing here claims predictive power.
 *
 * All date derivation goes through the local-date helpers (`new Date()` local
 * components -> `formatAlmanacDateKey`); a day is never sliced out of a UTC ISO
 * string and a "year" is the user's local year.
 */

/** Visible informational disclaimer (asserted in unit + e2e tests). */
export const ALMANAC_DISCLAIMER = '传统文化参考，非决策建议';

function todayKey(): string {
  return formatAlmanacDateKey(new Date());
}

function shiftDayKey(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatAlmanacDateKey(date);
}

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

function Chip({ text, tone }: { text: string; tone: 'good' | 'bad' | 'neutral' }) {
  const palette =
    tone === 'good'
      ? 'bg-emerald-100/80 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : tone === 'bad'
        ? 'bg-rose-100/80 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
        : 'bg-slate-100/80 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${palette}`}>{text}</span>;
}

const SECTION_DIVIDER = 'mt-4 border-t border-slate-200/60 dark:border-slate-700/60 pt-3';

export function AlmanacAdvancedPanel() {
  const [rangeStart, setRangeStart] = useState(todayKey);
  const [rangeEnd, setRangeEnd] = useState(() => shiftDayKey(30));
  const [purpose, setPurpose] = useState<string>(ALMANAC_PURPOSES[0]);
  const [auspicious, setAuspicious] = useState<AlmanacAuspiciousResult | null>(null);

  const [birth, setBirth] = useState('');
  const [bazi, setBazi] = useState<AlmanacBaziResult | null>(null);

  const [refDate, setRefDate] = useState(todayKey);

  const dayInfo = useMemo(() => getAlmanac(refDate), [refDate]);
  const rituals = useMemo(() => getRitualExtras(refDate), [refDate]);
  const zodiacCompat = useMemo(
    () => (dayInfo.zodiac ? getZodiacCompatibility(dayInfo.zodiac) : null),
    [dayInfo.zodiac],
  );
  const constellationCompat = useMemo(
    () => (dayInfo.constellation ? getConstellationCompatibility(dayInfo.constellation) : null),
    [dayInfo.constellation],
  );
  const baziResult = bazi?.bazi ?? null;

  return (
    <section
      className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10 mt-6"
      data-testid="almanac-advanced"
      aria-label="传统历法进阶"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200">传统历法进阶</h2>
        <span className="text-[10px] text-slate-400">本地历法库计算</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        择日、八字、生肖与星座配对按传统历法规则整理，仅供文化参考。
      </p>

      {/* 1. 黄道吉日 */}
      <div className={SECTION_DIVIDER} data-testid="almanac-auspicious">
        <h3 className="text-xs font-bold text-slate-700 dark:text-slate-200">黄道吉日查询</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <Label htmlFor="auspicious-start" className="text-[10px] text-slate-400">
              开始日期
            </Label>
            <Input
              id="auspicious-start"
              type="date"
              className="h-10 mt-1"
              value={rangeStart}
              onChange={(event) => setRangeStart(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="auspicious-end" className="text-[10px] text-slate-400">
              结束日期
            </Label>
            <Input
              id="auspicious-end"
              type="date"
              className="h-10 mt-1"
              value={rangeEnd}
              onChange={(event) => setRangeEnd(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="auspicious-purpose" className="text-[10px] text-slate-400">
              用途
            </Label>
            <Select
              id="auspicious-purpose"
              className="h-10 mt-1"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            >
              {ALMANAC_PURPOSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full"
              onClick={() => setAuspicious(searchAuspiciousDays(rangeStart, rangeEnd, purpose))}
            >
              查询
            </Button>
          </div>
        </div>

        {auspicious?.error && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" data-testid="auspicious-error">
            {auspicious.error}
          </p>
        )}
        {auspicious && !auspicious.error && (
          <div className="mt-2" data-testid="auspicious-results">
            {auspicious.results.length === 0 ? (
              <p className="text-xs text-slate-400">该范围内没有匹配「{auspicious.purpose}」的日子</p>
            ) : (
              <ul className="space-y-1">
                {auspicious.results.map((day) => (
                  <li
                    key={day.date}
                    className="flex flex-wrap items-center gap-x-2 text-xs text-slate-700 dark:text-slate-200"
                  >
                    <span className="font-medium">{day.date}</span>
                    <span className="text-slate-400">{day.lunarText ?? '—'}</span>
                    <span className="text-slate-400">{day.ganZhiDay ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-[10px] text-slate-400">已扫描 {auspicious.scanned} 天</p>
          </div>
        )}
      </div>

      {/* 2. 八字 / 五行 */}
      <div className={SECTION_DIVIDER} data-testid="almanac-bazi">
        <h3 className="text-xs font-bold text-slate-700 dark:text-slate-200">八字 / 五行</h3>
        <div className="mt-2 flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="bazi-birth" className="text-[10px] text-slate-400">
              出生时间
            </Label>
            <Input
              id="bazi-birth"
              className="h-10 mt-1"
              placeholder="1990-05-20 08:30"
              value={birth}
              onChange={(event) => setBirth(event.target.value)}
            />
          </div>
          <Button type="button" variant="outline" className="h-10" onClick={() => setBazi(getBazi(birth))}>
            排盘
          </Button>
        </div>

        {bazi?.error && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" data-testid="bazi-error">
            {bazi.error}
          </p>
        )}
        {baziResult && (
          <div className="mt-2" data-testid="bazi-result">
            <div className="grid grid-cols-4 gap-2">
              <Field label="年柱" value={baziResult.year.ganZhi} />
              <Field label="月柱" value={baziResult.month.ganZhi} />
              <Field label="日柱" value={baziResult.day.ganZhi} />
              <Field label="时柱" value={baziResult.hour.ganZhi} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-slate-400 mr-1">日主 {baziResult.dayMaster} · 五行</span>
              {ALMANAC_WU_XING.map((element) => (
                <Chip key={element} text={`${element}${baziResult.wuXingCounts[element]}`} tone="neutral" />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 3. 当日生肖 / 星座 · 彭祖百忌 · 吉神方位 */}
      <div className={SECTION_DIVIDER} data-testid="almanac-daily">
        <h3 className="text-xs font-bold text-slate-700 dark:text-slate-200">当日生肖 / 星座 · 彭祖百忌 · 吉神方位</h3>
        <div className="mt-2 max-w-[12rem]">
          <Label htmlFor="almanac-ref-date" className="text-[10px] text-slate-400">
            参考日期
          </Label>
          <Input
            id="almanac-ref-date"
            type="date"
            className="h-10 mt-1"
            value={refDate}
            onChange={(event) => setRefDate(event.target.value)}
          />
        </div>

        {rituals.error ? (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" data-testid="daily-error">
            {rituals.error}
          </p>
        ) : (
          <div className="mt-2 space-y-2" data-testid="daily-result">
            <div className="grid grid-cols-2 gap-2">
              <div data-testid="daily-zodiac">
                <p className="text-[10px] text-slate-400">生肖配对</p>
                <p className="text-xs text-slate-700 dark:text-slate-200">
                  {zodiacCompat
                    ? `${zodiacCompat.subject}：合 ${zodiacCompat.allies.join('、') || '—'} · 冲 ${
                        zodiacCompat.clashes.join('、') || '—'
                      }`
                    : '—'}
                </p>
              </div>
              <div data-testid="daily-constellation">
                <p className="text-[10px] text-slate-400">星座配对</p>
                <p className="text-xs text-slate-700 dark:text-slate-200">
                  {constellationCompat
                    ? `${constellationCompat.subject}（${constellationCompat.element ?? '—'}）：合 ${
                        constellationCompat.allies.join('、') || '—'
                      }`
                    : '—'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Field label="彭祖百忌（干）" value={rituals.pengZuGan} />
              <Field label="彭祖百忌（支）" value={rituals.pengZuZhi} />
              <Field label="当日干支" value={dayInfo.ganZhi.day} />
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-slate-400 mr-1">吉神宜趋</span>
              {rituals.jiShen.length > 0 ? (
                rituals.jiShen.map((item) => <Chip key={item} text={item} tone="good" />)
              ) : (
                <span className="text-[10px] text-slate-400">—</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-slate-400 mr-1">凶煞宜忌</span>
              {rituals.xiongSha.length > 0 ? (
                rituals.xiongSha.map((item) => <Chip key={item} text={item} tone="bad" />)
              ) : (
                <span className="text-[10px] text-slate-400">—</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-slate-400 mr-1">吉神方位</span>
              {dayInfo.positions.length > 0 ? (
                dayInfo.positions.map((position) => (
                  <Chip key={position.name} text={`${position.name}${position.direction ?? '—'}`} tone="neutral" />
                ))
              ) : (
                <span className="text-[10px] text-slate-400">—</span>
              )}
            </div>

            {(rituals.incompleteFields.length > 0 || dayInfo.incompleteFields.length > 0) && (
              <p className="text-[10px] text-slate-400" data-testid="daily-incomplete">
                数据不完整（{[...rituals.incompleteFields, ...dayInfo.incompleteFields].join('、')} 暂缺）
              </p>
            )}
          </div>
        )}
      </div>

      <p className="mt-4 text-[11px] font-medium text-amber-700 dark:text-amber-300" data-testid="almanac-disclaimer">
        {ALMANAC_DISCLAIMER}
      </p>
    </section>
  );
}
