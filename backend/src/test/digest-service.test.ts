import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  digestPeriodBounds,
  renderDigestHtml,
  renderDigestPdf,
  type DigestData,
} from '../services/digest.service.js';

/**
 * Checkbox 79 — pure rendering + period math. The real seeded-data SQL proof
 * lives in the PGlite live harness (`.omo/evidence/task-79-*`); this file pins
 * the deterministic HTML/PDF output and the byte-stability contract.
 */

function digestData(overrides: Partial<DigestData> = {}): DigestData {
  const base: DigestData = {
    userId: 1,
    period: 'monthly',
    from: '2026-09-01',
    to: '2026-09-30',
    today: '2026-10-01',
    upcoming: [
      { id: 1, name: '妈妈生日', type: 'birthday', date: '2026-10-05' },
      { id: 2, name: '房租续费', type: 'expiry', date: '2026-10-20' },
    ],
    overdue: [
      { kind: 'expiry', title: '域名续费', due: '2026-09-20', daysOverdue: 11 },
      { kind: 'maintenance', title: '汽车保养', due: '2026-09-25', daysOverdue: 6 },
      { kind: 'document', title: '护照', due: '2026-09-28', daysOverdue: 3 },
    ],
    spend: {
      from: '2026-09-01',
      to: '2026-09-30',
      byCurrency: { CNY: 12345 },
      onceByCurrency: { USD: 1000 },
      onceCount: 1,
      byKind: [{ kind: 'subscription', currency: 'CNY', cents: 12345, count: 2 }],
    },
    habits: [{ name: '晨跑', logged: 3, target: 6, rate: 50 }],
    medications: {
      taken: 5,
      skipped: 1,
      missed: 0,
      total: 6,
      percentage: 83,
      perMedication: [{ name: '布洛芬', taken: 5, skipped: 1, missed: 0, total: 6, percentage: 83 }],
    },
    maintenance: [{ assetName: '洗碗机', due: '2026-10-15', overdue: false }],
    goals: [{ title: '读完 12 本书', status: 'active', progress: 40, milestonesDone: 2, milestonesTotal: 5 }],
    isEmpty: false,
  };
  return { ...base, ...overrides };
}

describe('digestPeriodBounds', () => {
  it('monthly summarizes the previous calendar month', () => {
    expect(digestPeriodBounds('monthly', new Date('2026-10-15T00:00:00Z'))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(digestPeriodBounds('monthly', new Date('2026-01-03T00:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('yearly summarizes the previous calendar year', () => {
    expect(digestPeriodBounds('yearly', new Date('2026-06-01T00:00:00Z'))).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
});

describe('renderDigestHtml — every section renders its counts', () => {
  it('renders all seven section headings and the expected counts', () => {
    const html = renderDigestHtml(digestData());

    for (const heading of ['未来 30 天', '逾期事项', '订阅与到期支出', '习惯完成率', '用药依从性', '保养到期', '目标进度']) {
      expect(html).toContain(heading);
    }
    expect(html).toContain('妈妈生日');
    expect(html).toContain('¥123.45'); // 12345 cents
    expect(html).toContain('USD 10.00'); // once block keeps its own currency
    expect(html).toContain('晨跑');
    expect(html).toContain('50%');
    expect(html).toContain('布洛芬');
    expect(html).toContain('83%');
    expect(html).toContain('洗碗机');
    expect(html).toContain('读完 12 本书');
    expect(html).toContain('40%');
    expect(html).toContain('统计区间：');
    expect(html).not.toContain('本期无记录');
  });

  it('a zero-data account renders a valid 本期无记录 digest (never an empty body)', () => {
    const html = renderDigestHtml(
      digestData({ upcoming: [], overdue: [], maintenance: [], goals: [], habits: [], medications: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, perMedication: [] }, spend: { from: '2026-09-01', to: '2026-09-30', byCurrency: {}, onceByCurrency: {}, onceCount: 0, byKind: [] }, isEmpty: true }),
    );
    expect(html).toContain('本期无记录');
    expect(html).toContain('未来 30 天'); // sections still render, each with 无记录
    expect(html.length).toBeGreaterThan(200);
  });

  it('escapes user-controlled names (HTML/script injection)', () => {
    const html = renderDigestHtml(
      digestData({ goals: [{ title: '<img src=x onerror=alert(1)>', status: 'active', progress: 10, milestonesDone: 0, milestonesTotal: 1 }] }),
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('renderDigestPdf — byte stability', () => {
  function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  it('produces a real PDF and is byte-stable across two renders (no timestamp metadata)', async () => {
    const data = digestData();
    const first = await renderDigestPdf(data);
    const second = await renderDigestPdf(data);

    expect(Buffer.from(first).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sha256(first)).toBe(sha256(second));
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it('is byte-stable for the zero-data digest too', async () => {
    const data = digestData({ upcoming: [], overdue: [], maintenance: [], goals: [], habits: [], medications: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, perMedication: [] }, spend: { from: '2026-09-01', to: '2026-09-30', byCurrency: {}, onceByCurrency: {}, onceCount: 0, byKind: [] }, isEmpty: true });
    const first = await renderDigestPdf(data);
    const second = await renderDigestPdf(data);
    expect(sha256(first)).toBe(sha256(second));
  });
});
