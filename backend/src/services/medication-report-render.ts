import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import type { MedicationAdherence, MedicationRecord, RefillItem } from '@timemark/shared';
import { embedReportFont } from '../utils/pdf-font.js';
import type { AdherenceDailyPoint } from './medication.service.js';
import type { MedicationReportView } from './medication-report.service.js';

/**
 * 医生可读的用药依从性报告（checkbox 74）—— 渲染层：HTML / CSV / PDF。
 *
 * - HTML：完全自包含（内联 `<style>`，无外部 CSS/JS），视觉沿用 `components/ui/*`
 *   的卡片 / 边框 / 圆角 / slate 调色板；所有动态文本都被转义。
 * - CSV：**逐字段等于** checkbox 72 的依从性 payload（`GET /api/medications/adherence`），
 *   即 overall + 每药品的 taken/skipped/missed/total/percentage/currentStreak。
 * - PDF：pdf-lib + 内嵌 Noto Sans SC 子集（纯 JS、无浏览器），**字节稳定**：
 *   关闭 pdf-lib 的元数据写入（无 CreationDate/ModDate），内容只由 payload 决定。
 *
 * 纯记录：没有 AI 推断，没有医疗建议，只有事实表格与免责声明。
 */

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */

const REFILL_REASON_LABEL: Record<RefillItem['reason'], string> = {
  threshold: '库存低于阈值',
  days_of_supply: '预计不足 7 天',
  both: '库存低且预计不足 7 天',
};

function stockLabel(med: MedicationRecord): string {
  if (med.stock_quantity == null) return '—';
  return `${med.stock_quantity}${med.stock_unit ?? ''}`;
}

function scheduleLabel(med: MedicationRecord): string {
  return med.schedule_times.length > 0 ? med.schedule_times.join('、') : '按需';
}

function daysOfSupplyLabel(item: RefillItem): string {
  return item.daysOfSupply == null ? '无法推算' : `${item.daysOfSupply} 天`;
}

function adherenceFor(view: MedicationReportView, medicationId: number): MedicationAdherence | null {
  return view.adherence.medications.find((entry) => entry.medicationId === medicationId) ?? null;
}

function adherenceLabel(entry: MedicationAdherence | null): string {
  return entry ? `${entry.percentage}%` : '—';
}

/* ------------------------------------------------------------------ */
/* CSV —— 与 /adherence payload 逐字段一致                             */
/* ------------------------------------------------------------------ */

const CSV_HEADER = 'scope,medicationId,name,taken,skipped,missed,total,percentage,currentStreak';

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV = 依从性 payload 的表格化：overall 一行 + 每药品一行，列名即 payload 字段名。
 * 不含任何额外列/行，保证「CSV 与 payload 完全一致」可逐字段断言。
 */
export function renderMedicationReportCsv(view: MedicationReportView): string {
  const { overall, medications } = view.adherence;
  const rows: string[] = [
    CSV_HEADER,
    ['overall', '', '', overall.taken, overall.skipped, overall.missed, overall.total, overall.percentage, overall.currentStreak]
      .map(csvEscape)
      .join(','),
    ...medications.map((entry) =>
      ['medication', entry.medicationId, entry.name, entry.taken, entry.skipped, entry.missed, entry.total, entry.percentage, entry.currentStreak]
        .map(csvEscape)
        .join(','),
    ),
  ];
  return `${rows.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

const HTML_STYLE = `
:root{--bg:#f1f5f9;--card:#ffffff;--border:#e2e8f0;--muted:#64748b;--text:#0f172a;--primary:#2563eb;--green:#10b981;--amber:#f59e0b;--red:#ef4444}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;font-size:14px;line-height:1.65}
.report{max-width:840px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px 22px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.06)}
h1{font-size:22px;margin:0 0 8px;letter-spacing:.01em}
h2{font-size:15px;margin:0 0 12px;color:var(--text)}
.meta{margin:2px 0;color:var(--muted)}
.meta strong{color:var(--text)}
.hint{margin:10px 0 0;color:var(--muted);font-size:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:16px}
.stat{padding:14px 16px;margin-bottom:0}
.stat-value{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.stat-label{color:var(--muted);font-size:12px;margin-top:2px}
.stat--primary .stat-value{color:var(--primary)}
.stat--green .stat-value{color:var(--green)}
.stat--amber .stat-value{color:var(--amber)}
.stat--red .stat-value{color:var(--red)}
table{width:100%;border-collapse:collapse}
th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.empty{margin:0;padding:10px 0;color:var(--muted)}
.foot{color:var(--muted);font-size:12px;text-align:center;margin:8px 0 0}
@media print{body{background:#fff;padding:0}.card{box-shadow:none;break-inside:avoid}.stats{break-inside:avoid}}
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlStats(view: MedicationReportView): string {
  const { overall } = view.adherence;
  const items: Array<[string, string, string]> = [
    ['依从率', `${overall.percentage}%`, 'stat--primary'],
    ['已服', String(overall.taken), 'stat--green'],
    ['跳过', String(overall.skipped), 'stat--amber'],
    ['漏服', String(overall.missed), 'stat--red'],
    ['连续达标', `${overall.currentStreak} 天`, ''],
  ];
  return items
    .map(
      ([label, value, kind]) =>
        `<div class="card stat ${kind}"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div>`,
    )
    .join('');
}

function htmlDailySection(view: MedicationReportView): string {
  if (view.daily.length === 0) return '<p class="empty">无记录</p>';
  const rows = view.daily
    .map(
      (day: AdherenceDailyPoint) =>
        `<tr><td>${escapeHtml(day.date)}</td><td class="num">${day.taken}</td><td class="num">${day.skipped}</td><td class="num">${day.missed}</td><td class="num">${day.taken + day.skipped + day.missed}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>日期</th><th class="num">已服</th><th class="num">跳过</th><th class="num">漏服</th><th class="num">合计</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function htmlMedicationsSection(view: MedicationReportView): string {
  if (view.medications.length === 0) return '<p class="empty">无记录</p>';
  const rows = view.medications
    .map((med) => {
      const adherence = adherenceFor(view, med.id);
      const cells = [
        `<td>${escapeHtml(med.name)}</td>`,
        `<td>${escapeHtml(med.dosage ?? '—')}</td>`,
        `<td>${escapeHtml(scheduleLabel(med))}</td>`,
        `<td>${escapeHtml(stockLabel(med))}</td>`,
        `<td>${med.is_active ? '启用' : '停用'}</td>`,
        `<td class="num">${escapeHtml(adherenceLabel(adherence))}</td>`,
        `<td class="num">${adherence ? adherence.taken : '—'}</td>`,
        `<td class="num">${adherence ? adherence.skipped : '—'}</td>`,
        `<td class="num">${adherence ? adherence.missed : '—'}</td>`,
      ];
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return `<table><thead><tr><th>药品</th><th>剂量</th><th>计划时刻</th><th>库存</th><th>状态</th><th class="num">依从率</th><th class="num">已服</th><th class="num">跳过</th><th class="num">漏服</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function htmlRefillsSection(view: MedicationReportView): string {
  if (view.refills.length === 0) return '<p class="empty">暂无补货提醒</p>';
  const rows = view.refills
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(`${item.stockQuantity}${item.stockUnit ?? ''}`)}</td><td>${escapeHtml(daysOfSupplyLabel(item))}</td><td>${escapeHtml(REFILL_REASON_LABEL[item.reason])}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>药品</th><th>库存</th><th>预计可维持</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** 自包含的 HTML 报告（内联样式，无外部 CSS/JS；所有动态文本转义）。 */
export function renderMedicationReportHtml(view: MedicationReportView): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>用药依从性报告</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<main class="report">
<section class="card">
<h1>用药依从性报告</h1>
<p class="meta">患者档案：<strong>${escapeHtml(view.profileName)}</strong></p>
<p class="meta">报告期间：${escapeHtml(view.from)} 至 ${escapeHtml(view.to)}</p>
<p class="hint">统计口径：仅统计已结算剂量（已服 / 跳过 / 漏服），不含待服；本报告仅作记录，不作任何医疗判断。</p>
</section>
<section class="stats">${htmlStats(view)}</section>
<section class="card"><h2>每日明细</h2>${htmlDailySection(view)}</section>
<section class="card"><h2>用药清单与依从性</h2>${htmlMedicationsSection(view)}</section>
<section class="card"><h2>补货提醒</h2>${htmlRefillsSection(view)}</section>
<footer class="foot">本报告由 TimeMark 生成，仅供参考，不构成医疗建议。</footer>
</main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

const PAGE_SIZE: [number, number] = [595.28, 841.89];
const PAGE_MARGIN = 48;
const PAGE_BOTTOM = 64;

const SLATE_900 = rgb(0.06, 0.09, 0.16);
const SLATE_500 = rgb(0.39, 0.45, 0.55);
const RULE = rgb(0.89, 0.91, 0.94);
const BLUE = rgb(0.15, 0.39, 0.92);

interface PdfWriter {
  doc: PDFDocument;
  font: PDFFont;
  page: PDFPage;
  y: number;
}

interface PdfColumn {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

function ensureSpace(writer: PdfWriter, needed: number): void {
  if (writer.y - needed < PAGE_BOTTOM) {
    writer.page = writer.doc.addPage(PAGE_SIZE);
    writer.y = PAGE_SIZE[1] - PAGE_MARGIN;
  }
}

function writeLine(
  writer: PdfWriter,
  text: string,
  opts: { size?: number; color?: RGB; gap?: number } = {},
): void {
  const size = opts.size ?? 10;
  ensureSpace(writer, size + 6);
  writer.page.drawText(text, { x: PAGE_MARGIN, y: writer.y, size, font: writer.font, color: opts.color ?? SLATE_900 });
  writer.y -= size + (opts.gap ?? 6);
}

function fitText(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (text.length === 0) return text;
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

function drawTable(writer: PdfWriter, columns: PdfColumn[], rows: string[][]): void {
  const rowHeight = 15;
  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const drawRow = (cells: string[], size: number, color: RGB): void => {
    ensureSpace(writer, rowHeight);
    let x = PAGE_MARGIN;
    columns.forEach((column, index) => {
      const cell = cells[index] ?? '';
      if (cell.length > 0) {
        const text = fitText(writer.font, cell, column.width - 8, size);
        const textWidth = writer.font.widthOfTextAtSize(text, size);
        const drawX = column.align === 'right' ? x + column.width - 8 - textWidth : x;
        writer.page.drawText(text, { x: drawX, y: writer.y, size, font: writer.font, color });
      }
      x += column.width;
    });
    writer.y -= rowHeight;
  };

  drawRow(columns.map((column) => column.label), 9, SLATE_500);
  writer.page.drawLine({
    start: { x: PAGE_MARGIN, y: writer.y + 5 },
    end: { x: PAGE_MARGIN + totalWidth, y: writer.y + 5 },
    thickness: 0.6,
    color: RULE,
  });
  writer.y -= 5;
  for (const row of rows) drawRow(row, 9.5, SLATE_900);
  writer.y -= 6;
}

function pdfMedicationRows(view: MedicationReportView): string[][] {
  return view.medications.map((med) => {
    const adherence = adherenceFor(view, med.id);
    return [
      med.name,
      med.dosage ?? '—',
      scheduleLabel(med),
      stockLabel(med),
      med.is_active ? '启用' : '停用',
      adherenceLabel(adherence),
      String(adherence ? adherence.taken : '—'),
      String(adherence ? adherence.skipped : '—'),
      String(adherence ? adherence.missed : '—'),
    ];
  });
}

/**
 * A4 PDF。字节稳定的关键：`create({ updateMetadata: false })` 不写任何时间戳，
 * 页面内容完全由 payload 决定（无 Date.now、无随机 ID），subset 字体嵌入是确定性的。
 */
export async function renderMedicationReportPdf(view: MedicationReportView): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await embedReportFont(doc);
  const writer: PdfWriter = { doc, font, page: doc.addPage(PAGE_SIZE), y: PAGE_SIZE[1] - PAGE_MARGIN };

  const { overall } = view.adherence;
  writeLine(writer, '用药依从性报告', { size: 18, gap: 12 });
  writeLine(writer, `患者档案：${view.profileName}`, { size: 11, gap: 2 });
  writeLine(writer, `报告期间：${view.from} 至 ${view.to}`, { size: 11, gap: 2 });
  writeLine(writer, '统计口径：仅统计已结算剂量（已服/跳过/漏服），不含待服', { size: 9, color: SLATE_500, gap: 14 });
  writeLine(writer, `依从率：${overall.percentage}%`, { size: 13, color: BLUE, gap: 4 });
  writeLine(writer, `已服 ${overall.taken} / 跳过 ${overall.skipped} / 漏服 ${overall.missed} / 合计 ${overall.total}`, { size: 10, gap: 2 });
  writeLine(writer, `连续达标：${overall.currentStreak} 天`, { size: 10, gap: 18 });

  writeLine(writer, '每日明细', { size: 13, gap: 8 });
  if (view.daily.length === 0) {
    writeLine(writer, '无记录', { size: 10, color: SLATE_500, gap: 14 });
  } else {
    drawTable(
      writer,
      [
        { label: '日期', width: 120 },
        { label: '已服', width: 80, align: 'right' },
        { label: '跳过', width: 80, align: 'right' },
        { label: '漏服', width: 80, align: 'right' },
        { label: '合计', width: 80, align: 'right' },
      ],
      view.daily.map((day) => [day.date, String(day.taken), String(day.skipped), String(day.missed), String(day.taken + day.skipped + day.missed)]),
    );
  }

  writeLine(writer, '用药清单与依从性', { size: 13, gap: 8 });
  if (view.medications.length === 0) {
    writeLine(writer, '无记录', { size: 10, color: SLATE_500, gap: 14 });
  } else {
    drawTable(
      writer,
      [
        { label: '药品', width: 110 },
        { label: '剂量', width: 70 },
        { label: '计划时刻', width: 105 },
        { label: '库存', width: 70 },
        { label: '状态', width: 38 },
        { label: '依从率', width: 50, align: 'right' },
        { label: '已服', width: 42, align: 'right' },
        { label: '跳过', width: 42, align: 'right' },
        { label: '漏服', width: 42, align: 'right' },
      ],
      pdfMedicationRows(view),
    );
  }

  writeLine(writer, '补货提醒', { size: 13, gap: 8 });
  if (view.refills.length === 0) {
    writeLine(writer, '暂无补货提醒', { size: 10, color: SLATE_500, gap: 14 });
  } else {
    drawTable(
      writer,
      [
        { label: '药品', width: 160 },
        { label: '库存', width: 110 },
        { label: '预计可维持', width: 110 },
        { label: '原因', width: 119.28 },
      ],
      view.refills.map((item) => [
        item.name,
        `${item.stockQuantity}${item.stockUnit ?? ''}`,
        daysOfSupplyLabel(item),
        REFILL_REASON_LABEL[item.reason],
      ]),
    );
  }

  writeLine(writer, '本报告由 TimeMark 生成，仅供参考，不构成医疗建议。', { size: 9, color: SLATE_500 });

  return doc.save();
}
