/**
 * v2.44 R31：全站格式化收口——此前 fmtTime/fmtBytes/fmtSize 在 5 个文件里
 * 各自定义（语义漂移风险：Ocr 的 fmtBytes 最小显示 1KB，DataSources 的
 * fmtSize 支持-null 占位）。渐进替换：新代码一律从这里导入。
 */

/** 字节 → B/KB/MB（null/undefined → '—'） */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** ISO 时间 → 中文短格式（M/D HH:mm）；null → '—' */
export function formatShortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
