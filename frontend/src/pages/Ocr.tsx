import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Copy, Download, Loader2, ScanLine, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { formatBytes as fmtBytes } from '@/lib/format';

/**
 * v2.40 R17：OCR 扫描识别页——ocr 路由（task 146）此前 5 端点零 UI。
 * 调研（2026 趋势）：AI/OCR 自动捕获是个人管理应用标配（SmartScan 式
 * 拍照→结构化），本页做成「上传/拍照 → 抽取 → 结构化字段 + 一键存文档」闭环。
 */

type OcrStatus = {
  enabled: boolean;
  engine: string | null;
  local: boolean;
  supportedTypes: string[];
  maxBytes: number;
};

type OcrFields = {
  issuer: string | null;
  date: string | null;
  total: string | null;
  currency: string | null;
};

type OcrResultView = {
  id: number;
  engine: string;
  text: string;
  fields: OcrFields;
  byteSize: number;
};

type OcrHistoryRow = {
  id: number;
  engine: string;
  status: string;
  content_type: string;
  byte_size: number;
  text_excerpt: string;
  fields: OcrFields | null;
  created_at: string;
};

const ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf';
const FIELD_LABELS: Array<[keyof OcrFields, string]> = [
  ['issuer', '签发方'],
  ['date', '日期'],
  ['total', '金额'],
  ['currency', '币种'],
];

/** v2.41 R22：按识别文本推断证件类型——身份证/护照/驾照/签证/保单/合同/证书，默认 other */
export function inferDocKind(text: string): string {
  const t = typeof text === 'string' ? text : '';
  if (/居民身份证|身份证/.test(t)) return 'id_card';
  if (/护照|passport/i.test(t)) return 'passport';
  if (/驾驶证|驾照|行驶证/.test(t)) return 'driver_license';
  if (/签证|visa/i.test(t)) return 'visa';
  if (/保险单|保单|保险合同/.test(t)) return 'policy';
  if (/合同|协议书/.test(t)) return 'contract';
  if (/证书|毕业|学位|资格证/.test(t)) return 'certificate';
  return 'other';
}

const KIND_OPTIONS: Array<[string, string]> = [
  ['other', '其他'],
  ['id_card', '身份证'],
  ['passport', '护照'],
  ['driver_license', '驾照'],
  ['visa', '签证'],
  ['policy', '保单'],
  ['contract', '合同'],
  ['certificate', '证书'],
];

function fileToContentType(f: File): string | null {
  if (f.type && ACCEPT.split(',').includes(f.type)) return f.type;
  const byName = f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : null;
  return byName;
}

/** v2.40 R17：OCR 扫描识别（本地引擎，数据不出本机） */
export function Ocr() {
  const [status, setStatus] = useState<OcrStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  // v2.42 R25：多文件批量（files.length>1 走批量队列）
  const [files, setFiles] = useState<File[]>([]);
  const [batchResults, setBatchResults] = useState<Array<{ name: string; text: string; fields?: OcrFields; error?: string; saved?: boolean }> | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<OcrResultView | null>(null);
  const [history, setHistory] = useState<OcrHistoryRow[]>([]);
  const [saved, setSaved] = useState('');
  // v2.41 R22：保存为文档时的类型（识别完成后按文本自动预选，可手动改）
  const [docKind, setDocKind] = useState('other');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await api.get<{ enabled: boolean; engine: string | null; local: boolean; supportedTypes: string[]; maxBytes: number }>('/ocr');
      setStatus(res);
    } catch {
      setStatus(null);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.get<OcrHistoryRow[]>('/ocr/results?limit=20');
      setHistory(Array.isArray(res) ? res : []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, [loadStatus, loadHistory]);

  const handleExtract = useCallback(async () => {
    if (busy) return;
    if (files.length > 1) {
      // v2.42 R25：批量识别——逐个 POST，进度 x/y，失败项不阻断后续
      setBusy(true);
      setError('');
      setResult(null);
      setBatchResults([]);
      setBatchProgress({ done: 0, total: files.length });
      const collected: Array<{ name: string; text: string; fields?: OcrFields; error?: string }> = [];
      try {
        for (const f of files) {
          try {
            const contentType = fileToContentType(f);
            if (!contentType) throw new Error('不支持的类型');
            if (f.size > 2 * 1024 * 1024) throw new Error('超过 2 MB');
            const dataBase64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const s = String(reader.result ?? '');
                resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
              };
              reader.onerror = () => reject(new Error('读取失败'));
              reader.readAsDataURL(f);
            });
            const res = await api.post<OcrResultView>('/ocr', { contentType, dataBase64 });
            collected.push({ name: f.name, text: res.text, fields: res.fields });
          } catch (e) {
            collected.push({ name: f.name, text: '', error: e instanceof Error ? e.message : '识别失败' });
          }
          setBatchResults([...collected]);
          setBatchProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
        }
        void loadHistory();
      } finally {
        setBusy(false);
        setBatchProgress(null);
      }
      return;
    }
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    setBatchResults(null);
    setSaved('');
    try {
      const contentType = fileToContentType(file);
      if (!contentType) {
        setError('不支持的文件类型：仅 PNG / JPEG / WebP / PDF');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        setError('文件超过 2 MB 上限，请压缩后再试');
        return;
      }
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const s = String(reader.result ?? '');
          resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
        };
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const res = await api.post<OcrResultView>('/ocr', { contentType, dataBase64 });
      setResult(res);
      // v2.41 R22：按识别文本自动预选文档类型（用户可改）
      setDocKind(inferDocKind(res.text));
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : '识别失败');
    } finally {
      setBusy(false);
    }
  }, [file, files, busy, loadHistory]);

  /** v2.42 R25：批量结果逐条存文档 */
  const saveBatchItem = useCallback(async (idx: number) => {
    const item = batchResults?.[idx];
    if (!item || item.error) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      await api.post('/documents', {
        kind: inferDocKind(item.text),
        title: (item.fields?.issuer?.trim() || item.name.replace(/\.[a-z]+$/i, '')).slice(0, 120) + `（${today}）`,
        issuer: item.fields?.issuer?.trim().slice(0, 200) || null,
        notes: item.text.slice(0, 2000),
      });
      setBatchResults((prev) => prev?.map((r, i) => (i === idx ? { ...r, saved: true } : r)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '存为文档失败');
    }
  }, [batchResults]);

  const handleSaveDocument = useCallback(async () => {
    if (!result) return;
    const issuer = result.fields?.issuer ?? '';
    const today = new Date().toISOString().slice(0, 10);
    try {
      await api.post('/documents', {
        // v2.41 R22：按识别文本推断证件类型（不再一律 other）；签发日期可回填
        kind: docKind,
        title: (issuer.trim() || '扫描件').slice(0, 120) + `（${today}）`,
        issuer: issuer.trim().slice(0, 200) || null,
        issuedAt: /^\d{4}-\d{2}-\d{2}$/.test(result.fields?.date ?? '') ? result.fields.date : null,
        notes: result.text.slice(0, 2000),
      });
      setSaved('已存入「文档」');
    } catch (e) {
      setError(e instanceof Error ? e.message : '存为文档失败');
    }
  }, [result, docKind]);

  const handleDownload = useCallback(() => {
    if (!result) return;
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ocr-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  return (
    <div className="min-h-screen pb-24">
      <PageHeader title="扫描识别" subtitle="拍照上传 · 本地 OCR · 一键存文档" maxWidth="max-w-3xl" />
      <main className="max-w-3xl mx-auto px-6 mt-6 space-y-5">
        {/* 引擎状态 */}
        <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
            <ScanLine size={18} className="text-cyan-500" /> 识别引擎
          </h2>
          {status === null ? (
            <p className="text-sm text-slate-500">正在检查引擎状态…</p>
          ) : status.enabled ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              ✅ 引擎 {status.engine} 已就绪（{status.local ? '本地运行，数据不出本机' : '远程引擎'}）· 支持 PNG / JPEG / WebP / PDF · 单文件 ≤ {fmtBytes(status.maxBytes)}
            </p>
          ) : (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              OCR 未启用：部署时设置环境变量 <code className="font-mono">OCR_ENGINE=tesseract</code> 即可开启本地识别。
              上传校验（类型与大小）不受影响。
            </div>
          )}
        </section>

        {/* 上传与识别 */}
        <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
            <Camera size={18} className="text-blue-500" /> 上传扫描
          </h2>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            capture="environment"
            className="hidden"
            aria-label="选择或拍摄图片"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setFiles(picked);
              setFile(picked[0] ?? null);
              setResult(null);
              setBatchResults(null);
              setError('');
              setSaved('');
              setDocKind('other');
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" className="rounded-full min-h-11" onClick={() => fileRef.current?.click()}>
              <Camera size={14} className="mr-1.5" /> {file ? '重新选择' : '拍照 / 选文件'}
            </Button>
            <Button type="button" variant="vision" size="sm" className="rounded-full min-h-11" disabled={!file || busy} onClick={() => void handleExtract()}>
              {busy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Sparkles size={14} className="mr-1.5" />}
              {busy ? '识别中…' : files.length > 1 ? `开始识别（${files.length} 个文件）` : '开始识别'}
            </Button>
            {file && <span className="text-xs text-slate-400 self-center">{files.length > 1 ? `${files.length} 个文件` : file.name} · {fmtBytes(file.size)}</span>}
          </div>
          {batchProgress && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400" role="status">
              批量识别中：{batchProgress.done}/{batchProgress.total}
            </p>
          )}
          {batchResults && batchResults.length > 0 && (
            <ul className="mt-4 space-y-2" aria-label="批量识别结果">
              {batchResults.map((r, i) => (
                <li key={i} className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 p-3 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[50%]">{r.name}</span>
                    {r.error ? (
                      <span className="text-xs text-red-500">失败：{r.error}</span>
                    ) : (
                      <span className="text-xs text-slate-400 truncate flex-1">{r.text.slice(0, 60) || '（未识别到文本）'}</span>
                    )}
                    {!r.error && (
                      <button
                        type="button"
                        className="ml-auto text-xs font-bold text-primary-600 dark:text-primary-400 hover:underline shrink-0"
                        disabled={r.saved}
                        onClick={() => void saveBatchItem(i)}
                      >
                        {r.saved ? '已存入' : '存为文档'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

          {result && (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {FIELD_LABELS.map(([key, label]) => (
                  <span key={key} className="text-xs px-3 py-1 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">
                    {label}：{result.fields?.[key] || '—'}
                  </span>
                ))}
              </div>
              {/* v2.41 R22：存为文档的类型（识别完成自动预选，可改） */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-slate-500 dark:text-slate-400">存为文档类型：</span>
                {KIND_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={docKind === value}
                    onClick={() => setDocKind(value)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition ${docKind === value ? 'border-cyan-500 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 font-semibold' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50 px-4 py-3 text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-300 max-h-80 overflow-y-auto">
                {result.text || '（未识别到文本）'}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" className="rounded-full min-h-11" onClick={() => void navigator.clipboard.writeText(result.text).catch(() => undefined)}>
                  <Copy size={14} className="mr-1.5" /> 复制文本
                </Button>
                <Button type="button" variant="outline" size="sm" className="rounded-full min-h-11" onClick={handleDownload}>
                  <Download size={14} className="mr-1.5" /> 下载 .txt
                </Button>
                <Button type="button" variant="secondary" size="sm" className="rounded-full min-h-11" onClick={() => void handleSaveDocument()}>
                  <ScanLine size={14} className="mr-1.5" /> 存为文档
                </Button>
                {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400 self-center">{saved}</span>}
              </div>
            </div>
          )}
        </section>

        {/* 历史记录 */}
        <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
            <ScanLine size={18} className="text-slate-400" /> 最近识别
          </h2>
          {history.length === 0 ? (
            <EmptyState
              icon={ScanLine}
              title="还没有识别记录"
              description="拍一张票据或证件试试——识别结果可以一键存入文档库"
              action={
                <Button type="button" variant="secondary" size="sm" className="rounded-full" onClick={() => fileRef.current?.click()}>
                  <Camera size={14} className="mr-1.5" /> 开始第一次扫描
                </Button>
              }
            />
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li key={h.id} className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 p-3 text-xs">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">{h.fields?.issuer || '扫描件'}</span>
                    <span>· {h.engine}</span>
                    <span>· {fmtBytes(h.byte_size)}</span>
                    <span className="ml-auto">{new Date(h.created_at).toLocaleString('zh-CN')}</span>
                  </div>
                  <p className="mt-1 text-slate-500 dark:text-slate-400 line-clamp-2">{h.text_excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default Ocr;
