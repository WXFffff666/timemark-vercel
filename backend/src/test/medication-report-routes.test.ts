import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdherenceReport, MedicationRecord } from '@timemark/shared';

/**
 * Checkbox 74 acceptance, HTTP contract.
 *
 * The route is auth-guarded, validates window/format/range before any DB work,
 * maps a foreign/unknown profileId to 404 without ever calling the builder
 * (existence-leak guard), and writes the PDF as stable bytes.
 *
 * The rendering itself is asserted in `medication-report-render.test.ts`; here
 * the real renderers run against a fixture view so the wire shape (status,
 * content-type, body bytes) is covered end to end from the route.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(c, next);
    },
  };
});

const reportSvc = vi.hoisted(() => ({ buildMedicationReport: vi.fn() }));
vi.mock('../services/medication-report.service.js', () => reportSvc);

// /report never touches these services, but the module must not open a real pool.
vi.mock('../services/medication.service.js', () => ({
  createMedication: vi.fn(),
  deleteMedication: vi.fn(),
  getAdherence: vi.fn(),
  getAdherenceDaily: vi.fn(),
  getMedication: vi.fn(),
  getRefills: vi.fn(),
  getTodayDoses: vi.fn(),
  listMedications: vi.fn(),
  updateMedication: vi.fn(),
  logDose: vi.fn(),
  snoozeDose: vi.fn(),
}));

import medicationsRoutes from '../routes/medications.js';
import { renderMedicationReportCsv } from '../services/medication-report-render.js';
import type { MedicationReportView } from '../services/medication-report.service.js';
import { extractPdfText } from './pdf-text.js';

const USER = { id: 1, username: 'alice' };

function medication(overrides: Partial<MedicationRecord> & { id: number; name: string }): MedicationRecord {
  return {
    user_id: 1,
    profile_id: 11,
    dosage: null,
    form: 'tablet',
    schedule_times: [],
    schedule_days: null,
    start_date: '2026-09-01',
    end_date: null,
    stock_quantity: null,
    stock_unit: null,
    units_per_dose: 1,
    refill_threshold: null,
    prescriber: null,
    pharmacy: null,
    notes: null,
    is_active: true,
    is_critical: false,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

const ADHERENCE: AdherenceReport = {
  from: '2026-09-01',
  to: '2026-09-03',
  overall: { taken: 3, skipped: 1, missed: 2, total: 6, percentage: 50, currentStreak: 1 },
  medications: [
    { medicationId: 5, name: '二甲双胍', taken: 3, skipped: 1, missed: 2, total: 6, percentage: 50, currentStreak: 1 },
  ],
};

function fixture(overrides: Partial<MedicationReportView> = {}): MedicationReportView {
  return {
    profileId: null,
    profileName: '全部档案',
    from: '2026-09-01',
    to: '2026-09-03',
    adherence: ADHERENCE,
    daily: [{ date: '2026-09-01', taken: 2, skipped: 0, missed: 1 }],
    medications: [medication({ id: 5, name: '二甲双胍', dosage: '0.5g', schedule_times: ['08:00'] })],
    refills: [],
    ...overrides,
  };
}

function emptyFixture(): MedicationReportView {
  return fixture({
    adherence: {
      from: '2026-09-01',
      to: '2026-09-03',
      overall: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, currentStreak: 0 },
      medications: [],
    },
    daily: [],
    medications: [],
    refills: [],
  });
}

async function call(method: string, path: string): Promise<Response> {
  return medicationsRoutes.request(`http://localhost${path}`, { method });
}

beforeEach(() => {
  authState.user = { ...USER };
  reportSvc.buildMedicationReport.mockReset();
  dbQuery.mockReset();
  // parseProfileFilter -> findOwnedProfile: only profile 11 is owned by user 1.
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM profiles WHERE id = $1 AND user_id = $2 AND is_active = TRUE')) {
      const owned = Number(params[0]) === 11 && Number(params[1]) === 1;
      return owned ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe('GET /api/medications/report (checkbox 74)', () => {
  it('is auth-guarded', async () => {
    authState.user = null;
    expect((await call('GET', '/report?from=2026-09-01&to=2026-09-03')).status).toBe(401);
  });

  it('rejects malformed windows, unknown formats and oversized ranges before any data access', async () => {
    const cases = [
      ['/report', 400],
      ['/report?from=2026-09-01&to=bad', 400],
      ['/report?from=2026-09-01', 400],
      ['/report?from=2026-09-30&to=2026-09-01', 400],
      ['/report?from=2026-09-01&to=2026-09-03&format=docx', 400],
      ['/report?from=2020-01-01&to=2021-01-02', 400], // 368 days > 366
    ] as const;
    for (const [path, status] of cases) {
      const res = await call('GET', path);
      expect(res.status, path).toBe(status);
    }
    expect(reportSvc.buildMedicationReport).not.toHaveBeenCalled();
  });

  it('404s a foreign/unknown profileId without ever building a report (no leak)', async () => {
    expect((await call('GET', '/report?from=2026-09-01&to=2026-09-03&profileId=999')).status).toBe(404);
    expect((await call('GET', '/report?from=2026-09-01&to=2026-09-03&profileId=abc')).status).toBe(404);
    expect(reportSvc.buildMedicationReport).not.toHaveBeenCalled();
  });

  it('passes an owned profileId through and defaults to all profiles when omitted', async () => {
    reportSvc.buildMedicationReport.mockResolvedValue(fixture({ profileId: 11, profileName: '我' }));
    expect((await call('GET', '/report?from=2026-09-01&to=2026-09-03&profileId=11')).status).toBe(200);
    expect(reportSvc.buildMedicationReport).toHaveBeenLastCalledWith(1, '2026-09-01', '2026-09-03', { profileId: 11 });

    expect((await call('GET', '/report?from=2026-09-01&to=2026-09-03')).status).toBe(200);
    expect(reportSvc.buildMedicationReport).toHaveBeenLastCalledWith(1, '2026-09-01', '2026-09-03', { profileId: null });
  });

  it('defaults to an HTML report with the patient, period and percentage', async () => {
    reportSvc.buildMedicationReport.mockResolvedValue(fixture({ profileName: '我' }));
    const res = await call('GET', '/report?from=2026-09-01&to=2026-09-03');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    expect(html).toContain('患者档案：<strong>我</strong>');
    expect(html).toContain('2026-09-01');
    expect(html).toContain('50%');
  });

  it('returns CSV that equals the adherence payload exactly', async () => {
    const view = fixture({ profileName: '我' });
    reportSvc.buildMedicationReport.mockResolvedValue(view);
    const res = await call('GET', '/report?from=2026-09-01&to=2026-09-03&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toBe(renderMedicationReportCsv(view));
  });

  it('returns a byte-stable PDF whose text carries the period and the percentage', async () => {
    reportSvc.buildMedicationReport.mockResolvedValue(fixture());
    const first = Buffer.from(await (await call('GET', '/report?from=2026-09-01&to=2026-09-03&format=pdf')).arrayBuffer());
    const second = Buffer.from(await (await call('GET', '/report?from=2026-09-01&to=2026-09-03&format=pdf')).arrayBuffer());
    expect(first.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(createHash('sha256').update(first).digest('hex')).toBe(createHash('sha256').update(second).digest('hex'));
    const text = extractPdfText(first);
    expect(text).toContain('2026-09-01');
    expect(text).toContain('50%');
  });

  it('renders an empty period as a valid report stating 无记录', async () => {
    reportSvc.buildMedicationReport.mockResolvedValue(emptyFixture());
    const htmlRes = await call('GET', '/report?from=2026-09-01&to=2026-09-03');
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain('无记录');

    const pdfRes = await call('GET', '/report?from=2026-09-01&to=2026-09-03&format=pdf');
    expect(pdfRes.status).toBe(200);
    expect(extractPdfText(await pdfRes.arrayBuffer())).toContain('无记录');
  });

  it('maps a render failure to 500 without leaking internals', async () => {
    reportSvc.buildMedicationReport.mockRejectedValue(new Error('boom-secret-internal'));
    const res = await call('GET', '/report?from=2026-09-01&to=2026-09-03');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom-secret-internal');
  });
});
