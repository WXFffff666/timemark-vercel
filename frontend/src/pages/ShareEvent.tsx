import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  daysUntilEvent,
  resolveNextOccurrenceDate,
} from '@/lib/calendar-utils';
import {
  applyEventOgMeta,
  clearEventOgMeta,
  eventTypeLabel,
  formatCountdownDays,
} from '@/lib/og-meta';

interface ShareData {
  name: string;
  type: string;
  date: string;
  calendar_type: string;
  person_name?: string | null;
}

/** Days until the next occurrence, mirroring the embed widget's rolling logic. */
function countdownDays(data: ShareData): number {
  const next = resolveNextOccurrenceDate({
    date: data.date,
    type: data.type,
    calendarType: (data.calendar_type as 'gregorian') ?? 'gregorian',
    nextOccurrence: null,
  } as Parameters<typeof resolveNextOccurrenceDate>[0]);
  return daysUntilEvent(next);
}

export default function ShareEvent() {
  const { token } = useParams();
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetch(`/api/features/share/${token}`)
      .then((r) => r.json())
      .then((json) => {
        if (!active) return;
        if (json.success) setData(json.data as ShareData);
        else setError(json.error || '无法加载');
      })
      .catch(() => {
        if (active) setError('加载失败');
      });
    return () => {
      active = false;
    };
  }, [token]);

  // Client-injected OG/Twitter tags. Crawler-readable tags are served by `/api/og/share/:token`
  // (see the evidence file); this keeps the JS-rendered page accurate for social scrapers that
  // do execute scripts and for view-source inspection.
  useEffect(() => {
    if (!data || !token) return;
    const days = countdownDays(data);
    applyEventOgMeta({
      name: data.name,
      description: `${formatCountdownDays(days)} · ${eventTypeLabel(data.type)}`,
      imageUrl: `${window.location.origin}/api/og/image/${token}`,
      url: `${window.location.origin}/share/${token}`,
    });
    return () => clearEventOgMeta();
  }, [data, token]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-panel w-full max-w-md rounded-[2.5rem] p-10 text-center" data-testid="share-event-error">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-500/10 text-xl font-extrabold text-slate-500 dark:text-slate-300">
            !
          </span>
          <p className="text-slate-700 dark:text-slate-200">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="min-h-screen flex items-center justify-center text-hint">加载中…</div>;
  }

  const days = countdownDays(data);
  const isToday = days === 0;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <article
        className="glass-panel w-full max-w-md rounded-[2.5rem] p-8 shadow-xl animate-fade-in"
        data-testid="share-event-card"
      >
        <header className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-extrabold text-white shadow-lg">
            T
          </span>
          <div>
            <p className="text-sm font-bold text-slate-900 dark:text-white">TimeMark</p>
            <p className="text-xs text-hint">事件分享</p>
          </div>
        </header>

        <span className="inline-flex rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300">
          {eventTypeLabel(data.type)}
        </span>

        <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 dark:text-white">
          {data.name}
        </h1>

        <p
          className={
            isToday
              ? 'mt-6 text-4xl font-extrabold text-indigo-600 dark:text-indigo-400'
              : 'mt-6 text-5xl font-extrabold text-indigo-600 dark:text-indigo-400'
          }
          data-testid="share-countdown"
        >
          {formatCountdownDays(days)}
        </p>

        <p className="mt-3 text-sm text-hint">{data.date}</p>
        {data.person_name && <p className="mt-1 text-sm text-hint">相关人：{data.person_name}</p>}

        <div className="mt-8 border-t border-slate-200/70 pt-4 dark:border-white/10">
          <p className="text-xs text-hint">由 TimeMark 智能事件提醒生成</p>
        </div>

        {/* v2.38 R16（方面 10）：分享卡片图片生成——倒数日核心传播功能 */}
        <button
          type="button"
          onClick={() => void downloadCard(data, days)}
          className="mt-4 w-full rounded-2xl bg-gradient-to-b from-blue-500 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:brightness-110 active:scale-[0.98]"
          aria-label="下载分享卡片图片"
        >
          下载分享卡片
        </button>
      </article>
    </div>
  );
}

/** Canvas 渲染 600×900 分享卡（标题/类型/倒数/日期/品牌），导出 PNG。 */
async function downloadCard(data: ShareData, days: number): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 背景：柔和渐变
  const grad = ctx.createLinearGradient(0, 0, 0, 900);
  grad.addColorStop(0, '#4f46e5');
  grad.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 600, 900);

  // 类型徽章
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  roundRect(ctx, 60, 80, 160, 44, 22);
  ctx.fill();
  ctx.fillStyle = '#e0e7ff';
  ctx.font = 'bold 22px system-ui, -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(eventTypeLabel(data.type), 140, 110);

  // 标题（最多 2 行，每行 ≤10 个全角字符）
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px system-ui, -apple-system, "PingFang SC", sans-serif';
  const titleLines = splitLines(data.name, 10, 2);
  let y = 220;
  for (const line of titleLines) {
    ctx.fillText(line, 300, y);
    y += 60;
  }

  // 倒数大字
  ctx.fillStyle = '#a5b4fc';
  ctx.font = 'bold 120px system-ui, -apple-system, sans-serif';
  y += 60;
  if (days === 0) {
    ctx.fillText('就是今天', 300, y);
  } else {
    ctx.fillText(String(days), 300, y - 10);
    ctx.font = 'bold 36px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(days > 0 ? '天后' : '天前', 300, y + 46);
  }

  // 日期
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '28px system-ui, -apple-system, "PingFang SC", sans-serif';
  y += 110;
  ctx.fillText(data.date, 300, y);
  if (data.person_name) {
    y += 44;
    ctx.fillText(`相关人：${data.person_name}`, 300, y);
  }

  // 底部品牌
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '22px system-ui, -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('TimeMark · 智能事件提醒', 300, 830);

  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `timemark-${data.name.slice(0, 12)}-${data.date}.png`;
  a.click();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 全角近似：CJK 记 1，ASCII 记 0.5；按 maxPerLine 分行，超行截断加省略号。 */
function splitLines(text: string, maxPerLine: number, maxLines: number): string[] {
  const width = (ch: string): number => (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.5);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of text) {
    if (currentWidth + width(ch) > maxPerLine) {
      lines.push(current);
      current = ch;
      currentWidth = width(ch);
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
        return lines;
      }
    } else {
      current += ch;
      currentWidth += width(ch);
    }
  }
  if (current) lines.push(current);
  return lines;
}
