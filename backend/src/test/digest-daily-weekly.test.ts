import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v2.30 方向 A — 日报/周报：
 * 1. isDigestDue 按用户本地时区判断到点（daily 时刻 / weekly 星期+时刻）；
 * 2. respectEnabled 下 daily/weekly 有独立开关；
 * 3. 定时路径 skipDuplicates 查重（digest_archive 同期号只发一次）；
 * 4. cron /digest 端点接受 daily/weekly 并校验非法 period。
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  getAdherence: vi.fn(),
  getExpiryCosts: vi.fn(),
  createInboxMessage: vi.fn(),
  getNotificationAccounts: vi.fn(),
  getUserConfig: vi.fn(),
  resolveRecipientEmails: vi.fn(),
  resolveEmailAccount: vi.fn(),
  sendRawEmail: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));
vi.mock('../services/medication.service.js', () => ({ getAdherence: mocks.getAdherence }));
vi.mock('../services/expiry.service.js', () => ({ getExpiryCosts: mocks.getExpiryCosts }));
vi.mock('../services/inbox.service.js', () => ({ createInboxMessage: mocks.createInboxMessage }));
vi.mock('../services/config.service.js', () => ({
  getNotificationAccounts: mocks.getNotificationAccounts,
  getUserConfig: mocks.getUserConfig,
}));
vi.mock('../services/notifications/index.js', () => ({ resolveRecipientEmails: mocks.resolveRecipientEmails }));
vi.mock('../services/email-send.service.js', () => ({
  resolveEmailAccount: mocks.resolveEmailAccount,
  sendRawEmail: mocks.sendRawEmail,
}));

import { sendDigestForUser, isDigestDue } from '../services/digest.service.js';
import type { DigestPreferences } from '../services/digest.service.js';

function prefs(overrides: Partial<DigestPreferences> = {}): DigestPreferences {
  return {
    enabled: true,
    period: 'monthly',
    recipients: [],
    sections: null,
    channelAccountId: null,
    dailyEnabled: true,
    dailyTime: '21:00',
    weeklyEnabled: true,
    weeklyDay: 1,
    weeklyTime: '09:00',
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe('isDigestDue — 本地时区到点判断', () => {
  it('daily: fires after the configured local time (Asia/Shanghai)', () => {
    // 2026-10-06 13:00 UTC = 21:00 上海 → 到点
    const at2100 = new Date('2026-10-06T13:00:00Z');
    expect(isDigestDue(prefs(), 'daily', at2100, 'Asia/Shanghai')).toBe(true);
    // 12:59 UTC = 20:59 上海 → 未到
    const at2059 = new Date('2026-10-06T12:59:00Z');
    expect(isDigestDue(prefs(), 'daily', at2059, 'Asia/Shanghai')).toBe(false);
  });

  it('daily: honors an explicit timezone (UTC user vs Shanghai config)', () => {
    const at0900utc = new Date('2026-10-06T09:00:00Z');
    // UTC 用户的 09:00（配置 21:00）→ 未到
    expect(isDigestDue(prefs(), 'daily', at0900utc, 'UTC')).toBe(false);
    // 上海配置 09:00，UTC 01:00 = 上海 09:00 → 到点
    expect(isDigestDue(prefs({ dailyTime: '09:00' }), 'daily', new Date('2026-10-06T01:00:00Z'), 'Asia/Shanghai')).toBe(true);
  });

  it('daily: disabled switch blocks even past the time', () => {
    const at2200 = new Date('2026-10-06T14:00:00Z');
    expect(isDigestDue(prefs({ dailyEnabled: false }), 'daily', at2200, 'Asia/Shanghai')).toBe(false);
  });

  it('weekly: fires only on the configured weekday after the time', () => {
    // 2026-10-05 是周一；UTC 01:00 = 上海 09:00
    const monday0900 = new Date('2026-10-05T01:00:00Z');
    expect(isDigestDue(prefs({ weeklyDay: 1, weeklyTime: '09:00' }), 'weekly', monday0900, 'Asia/Shanghai')).toBe(true);
    // 周二同时刻 → 不发
    const tuesday0900 = new Date('2026-10-06T01:00:00Z');
    expect(isDigestDue(prefs({ weeklyDay: 1, weeklyTime: '09:00' }), 'weekly', tuesday0900, 'Asia/Shanghai')).toBe(false);
    // 周一 08:59 → 不发
    const monday0859 = new Date('2026-10-05T00:59:00Z');
    expect(isDigestDue(prefs({ weeklyDay: 1, weeklyTime: '09:00' }), 'weekly', monday0859, 'Asia/Shanghai')).toBe(false);
  });

  it('monthly/yearly are always due (existing behavior)', () => {
    expect(isDigestDue(prefs({ dailyEnabled: false, weeklyEnabled: false }), 'monthly', new Date(), 'Asia/Shanghai')).toBe(true);
  });

  it('invalid timezone falls back instead of throwing', () => {
    expect(() => isDigestDue(prefs(), 'daily', new Date('2026-10-06T13:00:00Z'), 'Not/AZone')).not.toThrow();
    expect(isDigestDue(prefs(), 'daily', new Date('2026-10-06T13:00:00Z'), 'Not/AZone')).toBe(true);
  });
});

describe('sendDigestForUser — daily/weekly 开关与查重', () => {
  function installHappyDb(): void {
    mocks.dbQuery.mockImplementation((sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (s.includes('FROM digest_archive')) return Promise.resolve({ rows: [] });
      if (s.includes('INSERT INTO digest_archive')) return Promise.resolve({ rows: [], rowCount: 1 });
      // buildDigestData 的各聚合查询给最小非空形状（照抄 digest-send 的 proven mock）
      if (s.includes('FROM events')) return Promise.resolve({ rows: [{ id: 1, name: '妈妈生日', type: 'birthday', occurrence: '2026-10-05' }], rowCount: 1 });
      if (s.includes("'expiry' AS kind")) return Promise.resolve({ rows: [{ kind: 'expiry', title: '域名续费', due: '2026-09-20' }], rowCount: 1 });
      if (s.includes('FROM habits h')) return Promise.resolve({ rows: [{ id: 1, name: '晨跑', target_per_period: 1, period: 'day', schedule_days: null, logged: 3 }], rowCount: 1 });
      if (s.includes('FROM maintenance_plans')) return Promise.resolve({ rows: [{ asset_name: '洗碗机', due: '2026-10-15' }], rowCount: 1 });
      if (s.includes('FROM goals g')) return Promise.resolve({ rows: [{ id: 1, title: '读完 12 本书', status: 'active', target_value: 10, current_value: 4, milestone_total: 2, milestone_done: 1 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mocks.getUserConfig.mockResolvedValue({ timezone: 'Asia/Shanghai', digest_daily_enabled: true });
    mocks.getAdherence.mockResolvedValue({
      from: '2026-10-05',
      to: '2026-10-05',
      overall: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, currentStreak: 0 },
      medications: [],
    });
    mocks.getExpiryCosts.mockResolvedValue({
      totalCents: 0, currency: null, mixedCurrencies: false, byCurrency: {}, byKind: [], monthly: [],
      once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
    });
    mocks.getNotificationAccounts.mockResolvedValue([]);
    mocks.resolveRecipientEmails.mockReturnValue(['me@example.com']);
    mocks.resolveEmailAccount.mockResolvedValue({ id: 1, type: 'resend', name: 'Resend', apiKey: 're_x', fromEmail: 'from@example.com' });
    mocks.sendRawEmail.mockResolvedValue(undefined);
    mocks.createInboxMessage.mockResolvedValue({ id: 1 });
  }

  it('respectEnabled: disabled daily schedule skips before any work', async () => {
    installHappyDb();
    mocks.getUserConfig.mockResolvedValue({ timezone: 'Asia/Shanghai', digest_daily_enabled: false });
    const result = await sendDigestForUser(1, 'daily', new Date('2026-10-06T14:00:00Z'), { respectEnabled: true });
    expect(result.skipped).toBe(true);
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
  });

  it('respectEnabled: before the configured time skips', async () => {
    installHappyDb();
    // 上海 20:59 → 未到 21:00
    const result = await sendDigestForUser(1, 'daily', new Date('2026-10-06T12:59:00Z'), { respectEnabled: true });
    expect(result.skipped).toBe(true);
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
  });

  it('manual send (no respectEnabled) works even if schedule disabled', async () => {
    installHappyDb();
    mocks.getUserConfig.mockResolvedValue({ timezone: 'Asia/Shanghai', digest_daily_enabled: false });
    const result = await sendDigestForUser(1, 'daily', new Date('2026-10-06T12:00:00Z'), {});
    expect(result.emailed).toBe(true);
    expect(mocks.sendRawEmail).toHaveBeenCalledTimes(1);
  });

  it('skipDuplicates: already-sent period short-circuits', async () => {
    installHappyDb();
    mocks.dbQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM digest_archive')) return Promise.resolve({ rows: [{ id: 9 }] });
      return Promise.resolve({ rows: [] });
    });
    const result = await sendDigestForUser(1, 'daily', new Date('2026-10-06T14:00:00Z'), {
      respectEnabled: true,
      skipDuplicates: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already_sent');
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
  });
});
