import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { createMedicationSchema, formatZodError, updateMedicationSchema } from '@timemark/shared';
import {
  createMedication,
  deleteMedication,
  getAdherence,
  getMedication,
  getRefills,
  getTodayDoses,
  listMedications,
  updateMedication,
} from '../services/medication.service.js';
import { buildMedicationReport } from '../services/medication-report.service.js';
import {
  renderMedicationReportCsv,
  renderMedicationReportHtml,
  renderMedicationReportPdf,
} from '../services/medication-report-render.js';
import { createLogger } from '../utils/logger.js';
import { parseProfileFilter } from './profile-filter.js';

/**
 * 家庭用药 API（D3，checkbox 72/74）。
 *
 * 约定与 /api/habits、/api/expiry 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`；「不存在」与「他人的行」都是 404（防存在性泄露）。
 * 路由顺序：/today、/adherence、/refills、/report 必须注册在 /:id 之前。
 *
 * `?profileId=` 为可选档案过滤（checkbox 69）：省略 = 全部档案，他人的档案 404。
 */
const medications = new Hono<{ Variables: { user: User } }>();
medications.use('*', authMiddleware);

const reportLog = createLogger('medications.report');

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

medications.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }

  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const data = await listMedications(userId, { active, profileId: profileFilter });
  return c.json({ success: true, data });
});

// 「今天」：先物化今天再取回；必须早于 /:id
medications.get('/today', async (c) => {
  const userId = Number(c.get('user').id);
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const data = await getTodayDoses(userId, { profileId: profileFilter });
  return c.json({ success: true, data });
});

medications.get('/adherence', async (c) => {
  const userId = Number(c.get('user').id);
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!YMD_RE.test(from) || !YMD_RE.test(to)) {
    return c.json({ success: false, error: 'from / to 必须为 YYYY-MM-DD' }, 400);
  }
  if (from > to) {
    return c.json({ success: false, error: 'from 不能晚于 to' }, 400);
  }

  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const data = await getAdherence(userId, from, to, { profileId: profileFilter });
  return c.json({ success: true, data });
});

medications.get('/refills', async (c) => {
  const userId = Number(c.get('user').id);
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const data = await getRefills(userId, { profileId: profileFilter });
  return c.json({ success: true, data });
});

/* ------------------------------------------------------------------ */
/* 医生可读报告（checkbox 74）                                          */
/* ------------------------------------------------------------------ */

const REPORT_FORMATS = ['pdf', 'html', 'csv'] as const;
type ReportFormat = (typeof REPORT_FORMATS)[number];
/** 报告区间上限（天）：医生报告以周/月为单位，366 天足够且挡住整库扫描式入参。 */
export const REPORT_MAX_DAYS = 366;

function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

function reportRangeDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * `GET /api/medications/report?from=&to=&format=pdf|html|csv[&profileId=]`
 *
 * - `from` / `to` 必须为 YYYY-MM-DD 且 from <= to，区间最长 366 天（400 拒绝）。
 * - `format` 省略 = `html`；未知格式 400。
 * - `profileId` 归属校验与其它用药接口一致：他人的 / 不存在的档案 404，绝不泄露。
 * - CSV 与 `GET /api/medications/adherence` 的 payload 逐字段一致；PDF 字节稳定。
 */
medications.get('/report', async (c) => {
  const userId = Number(c.get('user').id);
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!YMD_RE.test(from) || !YMD_RE.test(to)) {
    return c.json({ success: false, error: 'from / to 必须为 YYYY-MM-DD' }, 400);
  }
  if (from > to) {
    return c.json({ success: false, error: 'from 不能晚于 to' }, 400);
  }
  const formatRaw = c.req.query('format') ?? 'html';
  if (!isReportFormat(formatRaw)) {
    return c.json({ success: false, error: 'format 必须为 pdf|html|csv' }, 400);
  }
  if (reportRangeDays(from, to) > REPORT_MAX_DAYS) {
    return c.json({ success: false, error: `报告区间最长 ${REPORT_MAX_DAYS} 天` }, 400);
  }

  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  try {
    const view = await buildMedicationReport(userId, from, to, { profileId: profileFilter });
    const filename = `medication-report-${from}_${to}`;
    if (formatRaw === 'csv') {
      return c.body(renderMedicationReportCsv(view), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
        'Cache-Control': 'private, no-store',
      });
    }
    if (formatRaw === 'pdf') {
      const pdf = await renderMedicationReportPdf(view);
      // `new Uint8Array(pdf)` gives an exact-length ArrayBuffer view (copy avoids
      // any byteOffset surprises from pdf-lib's internal buffer).
      return c.body(new Uint8Array(pdf).buffer, 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}.pdf"`,
        'Cache-Control': 'private, no-store',
      });
    }
    return c.html(renderMedicationReportHtml(view), 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    reportLog.error({ event: 'medications.report.render_failed', err }, '用药报告生成失败');
    return c.json({ success: false, error: '报告生成失败' }, 500);
  }
});

medications.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createMedicationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const data = await createMedication(userId, parsed.data);
  return c.json({ success: true, data }, 201);
});

medications.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const data = await getMedication(userId, id);
  if (!data) return c.json({ success: false, error: '药品不存在' }, 404);
  return c.json({ success: true, data });
});

medications.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateMedicationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const data = await updateMedication(userId, id, parsed.data);
  if (!data) return c.json({ success: false, error: '药品不存在' }, 404);
  return c.json({ success: true, data });
});

medications.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteMedication(userId, id);
  if (!deleted) return c.json({ success: false, error: '药品不存在' }, 404);
  return c.json({ success: true });
});

export default medications;
