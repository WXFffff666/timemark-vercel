import { useCallback, useState } from 'react';
import { CalendarDays, Contact, FileText, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import './print-export.css';

/**
 * Task 147 — print/export panel.
 *
 * Every action opens a SELF-CONTAINED print-ready HTML document served by
 * `/api/export/*.pdf` (the browser's print dialog turns it into a PDF). No
 * remote asset, font or CDN is ever requested by the generated page. When the
 * session uses cookie auth the new tab authenticates itself; in legacy Bearer
 * mode the document is fetched with the header and opened from a blob URL.
 */
const today = new Date().toISOString().slice(0, 10);
const currentMonth = new Date().toISOString().slice(0, 7);

function shiftDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

async function openPrintView(path: string): Promise<void> {
  const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
  if (!token) {
    window.open(path, '_blank', 'noopener');
    return;
  }
  const response = await fetch(path, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('export failed');
  const html = await response.text();
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ExportPanel() {
  const [month, setMonth] = useState(currentMonth);
  const [from, setFrom] = useState(shiftDays(today, -29));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, path: string) => {
    setBusy(key);
    setError(null);
    try {
      await openPrintView(path);
    } catch {
      setError('打印视图打开失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <section className="export-panel">
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
        <Printer className="w-4 h-4" /> 打印 / 导出
      </h2>
      <div className="glass-panel rounded-[2.5rem] p-6 space-y-5 ring-1 ring-black/5 dark:ring-white/10">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          生成自包含的可打印页面（浏览器「打印/另存为 PDF」即可导出）。页面不加载任何外部字体或资源，完全离线渲染。
        </p>

        <div className="export-actions space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              日历月份
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm text-slate-900 dark:text-white"
                aria-label="日历月份"
              />
            </label>
            <Button
              onClick={() => void run('calendar', `/api/export/calendar.pdf?month=${encodeURIComponent(month)}`)}
              disabled={busy !== null || !month}
              className="gap-2"
            >
              <CalendarDays className="w-4 h-4" /> {busy === 'calendar' ? '生成中…' : '打印日历 PDF'}
            </Button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              报告起始
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm text-slate-900 dark:text-white"
                aria-label="报告起始日期"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              报告结束
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm text-slate-900 dark:text-white"
                aria-label="报告结束日期"
              />
            </label>
            <Button
              onClick={() =>
                void run('report', `/api/export/report.pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
              }
              disabled={busy !== null || !from || !to}
              className="gap-2"
            >
              <FileText className="w-4 h-4" /> {busy === 'report' ? '生成中…' : '打印报告 PDF'}
            </Button>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => void run('contacts', '/api/export/contacts.pdf')}
              disabled={busy !== null}
              className="gap-2"
            >
              <Contact className="w-4 h-4" /> {busy === 'contacts' ? '生成中…' : '打印联系人卡片 PDF'}
            </Button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500" role="status">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export default ExportPanel;
