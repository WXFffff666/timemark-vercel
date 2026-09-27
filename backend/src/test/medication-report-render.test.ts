import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdherenceReport, MedicationRecord, RefillItem } from '@timemark/shared';
import {
  renderMedicationReportCsv,
  renderMedicationReportHtml,
  renderMedicationReportPdf,
} from '../services/medication-report-render.js';
import type { MedicationReportView } from '../services/medication-report.service.js';
import type { AdherenceDailyPoint } from '../services/medication.service.js';
import { extractPdfText } from './pdf-text.js';

/**
 * Checkbox 74 acceptance, rendering layer.
 *
 * - CSV is asserted field-for-field against the adherence payload (the exact
 *   source of truth from `GET /api/medications/adherence`).
 * - PDF byte-stability is asserted on the real pdf-lib output (sha256 twice).
 * - PDF text is asserted by decoding the produced PDF (ToUnicode + content
 *   streams), i.e. the period and percentage really are rendered text.
 * - The empty period must produce 无记录 - and the HTML must NOT contain a table
 *   at all (an empty table would fail this test by construction).
 */

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

const OVERALL = { taken: 3, skipped: 1, missed: 2, total: 6, percentage: 50, currentStreak: 1 };

function view(overrides: Partial<MedicationReportView> = {}): MedicationReportView {
  const adherence: AdherenceReport = {
    from: '2026-09-01',
    to: '2026-09-03',
    overall: { ...OVERALL },
    medications: [{ medicationId: 5, name: '二甲双胍', ...OVERALL }],
  };
  const daily: AdherenceDailyPoint[] = [
    { date: '2026-09-01', taken: 2, skipped: 0, missed: 1 },
    { date: '2026-09-02', taken: 1, skipped: 1, missed: 0 },
    { date: '2026-09-03', taken: 0, skipped: 0, missed: 1 },
  ];
  const refills: RefillItem[] = [
    {
      medicationId: 5,
      name: '二甲双胍',
      profile_id: 11,
      stockQuantity: 12,
      stockUnit: '片',
      unitsPerDose: 1,
      refillThreshold: 20,
      daysOfSupply: 6,
      reason: 'both',
    },
  ];
  return {
    profileId: 11,
    profileName: '我',
    from: '2026-09-01',
    to: '2026-09-03',
    adherence,
    daily,
    medications: [
      medication({
        id: 5,
        name: '二甲双胍',
        dosage: '0.5g',
        schedule_times: ['08:00', '20:00'],
        stock_quantity: 12,
        stock_unit: '片',
      }),
    ],
    refills,
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const EMPTY_ADHERENCE: AdherenceReport = {
  from: '2026-09-01',
  to: '2026-09-03',
  overall: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, currentStreak: 0 },
  medications: [],
};

function emptyView(): MedicationReportView {
  return view({
    adherence: {
      from: EMPTY_ADHERENCE.from,
      to: EMPTY_ADHERENCE.to,
      overall: { ...EMPTY_ADHERENCE.overall },
      medications: [],
    },
    daily: [],
    medications: [],
    refills: [],
  });
}

describe('medication report CSV (checkbox 74)', () => {
  it('serializes the adherence payload field-for-field, and nothing else', () => {
    const report = view();
    const csv = renderMedicationReportCsv(report);

    // Independently derived from the payload that GET /adherence returns.
    const { overall, medications } = report.adherence;
    const expected = [
      'scope,medicationId,name,taken,skipped,missed,total,percentage,currentStreak',
      `overall,,,${overall.taken},${overall.skipped},${overall.missed},${overall.total},${overall.percentage},${overall.currentStreak}`,
      ...medications.map(
        (entry) =>
          `medication,${entry.medicationId},${entry.name},${entry.taken},${entry.skipped},${entry.missed},${entry.total},${entry.percentage},${entry.currentStreak}`,
      ),
    ].join('\n');

    expect(csv).toBe(`${expected}\n`);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(1 + 1 + medications.length);
    expect(lines[0]?.split(',')).toEqual([
      'scope',
      'medicationId',
      'name',
      'taken',
      'skipped',
      'missed',
      'total',
      'percentage',
      'currentStreak',
    ]);
  });

  it('escapes a medication name containing commas and quotes without breaking the payload columns', () => {
    const hostileName = '复方, "感冒" 灵';
    const report = view({
      adherence: {
        from: '2026-09-01',
        to: '2026-09-03',
        overall: { taken: 1, skipped: 0, missed: 0, total: 1, percentage: 100, currentStreak: 1 },
        medications: [
          { medicationId: 7, name: hostileName, taken: 1, skipped: 0, missed: 0, total: 1, percentage: 100, currentStreak: 1 },
        ],
      },
    });
    const csv = renderMedicationReportCsv(report);
    expect(csv).toContain('medication,7,"复方, ""感冒"" 灵",1,0,0,1,100,1');
    // The escaped row still parses back to exactly 9 columns.
    const row = csv.trimEnd().split('\n')[2] ?? '';
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < row.length; i += 1) {
      const ch = row[i];
      if (quoted) {
        if (ch === '"' && row[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        cells.push(cell);
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell);
    expect(cells).toEqual(['medication', '7', '复方, "感冒" 灵', '1', '0', '0', '1', '100', '1']);
  });

  it('keeps the empty period a valid zero payload instead of a broken table', () => {
    const csv = renderMedicationReportCsv(emptyView());
    expect(csv).toBe(
      'scope,medicationId,name,taken,skipped,missed,total,percentage,currentStreak\noverall,,,0,0,0,0,0,0\n',
    );
  });
});

describe('medication report PDF (checkbox 74)', () => {
  it('is byte-stable across two identical requests', async () => {
    const report = view();
    const first = await renderMedicationReportPdf(report);
    const second = await renderMedicationReportPdf(report);
    expect(sha256(first)).toBe(sha256(second));
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
    expect(Buffer.from(first).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('extracts the period and the percentage as rendered text', async () => {
    const pdf = await renderMedicationReportPdf(view());
    const text = extractPdfText(pdf);
    expect(text).toContain('2026-09-01');
    expect(text).toContain('2026-09-03');
    expect(text).toContain('50%');
    expect(text).toContain('二甲双胍');
    expect(text).toContain('0.5g');
  });

  it('renders 无记录 for an empty period (valid report, not a broken table)', async () => {
    const pdf = await renderMedicationReportPdf(emptyView());
    const text = extractPdfText(pdf);
    // 每日明细 and 用药清单 both state 无记录 (an empty table would render nothing).
    expect(text.split('无记录')).toHaveLength(3);
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('stays byte-stable with a multi-page daily table', async () => {
    const daily: AdherenceDailyPoint[] = [];
    const start = Date.UTC(2026, 0, 1);
    for (let day = 0; day < 366; day += 1) {
      const date = new Date(start + day * 86_400_000);
      daily.push({
        date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
        taken: day % 3,
        skipped: day % 2,
        missed: day % 5,
      });
    }
    const report = view({ daily, from: '2026-01-01', to: '2027-01-01' });
    const first = await renderMedicationReportPdf(report);
    const second = await renderMedicationReportPdf(report);
    expect(sha256(first)).toBe(sha256(second));
    const text = extractPdfText(first);
    expect(text).toContain('2026-01-01');
    expect(text).toContain('2027-01-01');
  });

  it('renders a zero-dose period at 0% without dividing by zero', async () => {
    const report = view({
      adherence: {
        from: '2026-09-01',
        to: '2026-09-03',
        overall: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, currentStreak: 0 },
        medications: [],
      },
      daily: [],
      medications: [medication({ id: 9, name: '维生素D', dosage: null })],
    });
    const pdf = await renderMedicationReportPdf(report);
    const text = extractPdfText(pdf);
    expect(text).toContain('依从率：0%');
    expect(text).toContain('维生素D');
    expect(text).toContain('—'); // null dosage placeholder
  });
});

describe('medication report HTML (checkbox 74)', () => {
  it('reuses the ui look inline and shows the full report', () => {
    const html = renderMedicationReportHtml(view());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).toContain('我');
    expect(html).toContain('2026-09-01');
    expect(html).toContain('50%');
    expect(html).toContain('二甲双胍');
    expect(html).toContain('0.5g');
    expect(html).toContain('库存低且预计不足 7 天');
    // Per-day rows are part of the printable report.
    expect(html).toContain('2026-09-02');
  });

  it('escapes injected markup in every dynamic field', () => {
    const hostile = '<script>alert("x")</script>';
    const report = view({
      profileName: hostile,
      medications: [medication({ id: 5, name: `二甲双胍${hostile}`, dosage: hostile })],
      refills: [
        {
          medicationId: 5,
          name: hostile,
          profile_id: 11,
          stockQuantity: 1,
          stockUnit: hostile,
          unitsPerDose: 1,
          refillThreshold: 2,
          daysOfSupply: 1,
          reason: 'both',
        },
      ],
    });
    report.adherence.medications = [{ medicationId: 5, name: hostile, ...OVERALL }];
    const html = renderMedicationReportHtml(report);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;x&quot;');
  });

  it('renders the empty period as 无记录 with no table at all', () => {
    const html = renderMedicationReportHtml(emptyView());
    expect(html).toContain('无记录');
    expect(html).toContain('0%');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<tbody');
  });
});
