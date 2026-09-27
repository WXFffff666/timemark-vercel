import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 80 — the persisted digest settings row is actually RESPECTED by the
 * cron/send path.
 *
 * Proves with mocked collaborators:
 * - the cron skips a user whose `digest_enabled` is false (no build, no email);
 * - an excluded section is absent from the rendered HTML body;
 * - a recipient override wins over `resolveRecipientEmails`;
 * - the selected channel account id is forwarded to `resolveEmailAccount`;
 * - the preview returns REAL data even when no email channel exists, plus a
 *   `no_email_channel` reason instead of failing silently;
 * - recipient overrides are sanitized (CRLF / 2000-char / non-email dropped).
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

import {
  buildDigestPreview,
  selectDigestSections,
  sendDigestForUser,
  sendDigestsForAllUsers,
  type DigestData,
} from '../services/digest.service.js';
import { normalizeDigestSections, sanitizeDigestRecipients } from '../services/digest-sections.js';

function installDb(): void {
  mocks.dbQuery.mockReset();
  mocks.dbQuery.mockImplementation(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM events')) return { rows: [{ id: 1, name: '妈妈生日', type: 'birthday', occurrence: '2026-10-05' }], rowCount: 1 };
    if (s.includes("'expiry' AS kind")) return { rows: [{ kind: 'expiry', title: '域名续费', due: '2026-09-20' }], rowCount: 1 };
    if (s.includes('FROM habits h')) return { rows: [{ id: 1, name: '晨跑', target_per_period: 1, period: 'day', schedule_days: null, logged: 3 }], rowCount: 1 };
    if (s.includes('FROM maintenance_plans')) return { rows: [{ asset_name: '洗碗机', due: '2026-10-15' }], rowCount: 1 };
    if (s.includes('FROM goals g')) return { rows: [{ id: 1, title: '读完 12 本书', status: 'active', target_value: 10, current_value: 4, milestone_total: 2, milestone_done: 1 }], rowCount: 1 };
    if (s.includes('FROM users')) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  });
}

function installCollaborators(): void {
  mocks.getAdherence.mockResolvedValue({
    from: '2026-09-01',
    to: '2026-09-30',
    overall: { taken: 2, skipped: 1, missed: 0, total: 3, percentage: 67, currentStreak: 0 },
    medications: [{ medicationId: 1, name: '布洛芬', taken: 2, skipped: 1, missed: 0, total: 3, percentage: 67, currentStreak: 0 }],
  });
  mocks.getExpiryCosts.mockResolvedValue({
    totalCents: 1000, currency: 'CNY', mixedCurrencies: false, byCurrency: { CNY: 1000 }, byKind: [], monthly: [],
    once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
  });
  mocks.createInboxMessage.mockResolvedValue({ id: 9 });
  mocks.getNotificationAccounts.mockResolvedValue([
    { id: 1, user_id: 1, type: 'resend', name: 'Resend', webhook: null, token: 're_x', secret: null, chat_id: null, is_active: true, config_method: 'token', session_data: null, plugin_package: null, connection_status: null, created_at: '', updated_at: '' },
  ]);
  mocks.getUserConfig.mockResolvedValue({ default_test_email: 'me@example.com', reminder_emails: [] });
  mocks.resolveRecipientEmails.mockReturnValue(['me@example.com']);
  mocks.resolveEmailAccount.mockResolvedValue({ id: 1, type: 'resend', name: 'Resend', apiKey: 're_x', fromEmail: 'from@example.com' });
  mocks.sendRawEmail.mockResolvedValue(undefined);
}

beforeEach(() => {
  installDb();
  installCollaborators();
});

describe('cron respects the settings row', () => {
  it('disabled => no send at all (proving the disabled-branch has teeth)', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_enabled: false });

    const batch = await sendDigestsForAllUsers('monthly', new Date('2026-10-15T00:00:00Z'));

    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
    expect(batch).toMatchObject({ users: 2, sent: 0, skipped: 2 });
    expect(batch.results.every((r) => r.skipped === true && r.emailed === false)).toBe(true);

    // Negative control: the SAME run with the default (enabled) row DOES send, so
    // the assertion above is not vacuously true because of some other failure.
    installCollaborators();
    const enabledBatch = await sendDigestsForAllUsers('monthly', new Date('2026-10-15T00:00:00Z'));
    expect(enabledBatch.sent).toBe(2);
    expect(mocks.sendRawEmail).toHaveBeenCalledTimes(2);
  });

  it('an explicit manual send still works when the scheduled digest is disabled', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_enabled: false, default_test_email: 'me@example.com' });

    const result = await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    expect(result.emailed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(mocks.sendRawEmail).toHaveBeenCalledTimes(1);
  });
});

describe('section selection is enforced', () => {
  it('an excluded section is absent from the rendered email body', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_sections: ['goals'] });

    await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    const html = String((mocks.sendRawEmail.mock.calls[0] as [unknown, unknown, unknown, string])[3]);

    expect(html).toContain('目标进度');
    expect(html).toContain('读完 12 本书');
    expect(html).not.toContain('未来 30 天');
    expect(html).not.toContain('妈妈生日');
    expect(html).not.toContain('用药依从性');
    expect(html).not.toContain('布洛芬');
  });

  it('an empty selection is normalized to ALL sections so it never renders an empty digest', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_sections: [] });

    await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    const html = String((mocks.sendRawEmail.mock.calls[0] as [unknown, unknown, unknown, string])[3]);

    expect(html).toContain('未来 30 天');
    expect(html).toContain('妈妈生日');
    expect(html).toContain('目标进度');
  });
});

describe('recipient override wins over resolveRecipientEmails', () => {
  it('delivers to the sanitized override instead of the resolved default', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_recipients: ['ov@example.com'] });
    mocks.resolveRecipientEmails.mockReturnValue(['me@example.com']);

    await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    const [, to] = mocks.sendRawEmail.mock.calls[0] as [unknown, string[]];
    expect(to).toEqual(['ov@example.com']);
    expect(to).not.toContain('me@example.com');
  });

  it('overrides with 5 addresses keep all 5 (dedup, no cap below 20)', () => {
    expect(
      sanitizeDigestRecipients(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']),
    ).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  });

  it('hostile / malformed overrides are dropped, never reaching the header', () => {
    expect(sanitizeDigestRecipients(['evil@x.com\r\nBcc: bad@y.com'])).toEqual([]);
    expect(sanitizeDigestRecipients([`${'a'.repeat(2000)}@x.com`])).toEqual([]);
    expect(sanitizeDigestRecipients(['not-an-email', '  spaced@x.com  '])).toEqual(['spaced@x.com']);
    expect(sanitizeDigestRecipients(['A@X.com', 'a@x.com'])).toEqual(['a@x.com']);
  });
});

describe('channel selection', () => {
  it('forwards the chosen account id to resolveEmailAccount', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_channel_account_id: 3 });

    await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    expect(mocks.resolveEmailAccount).toHaveBeenCalledWith(1, 3);
  });

  it('an unconfigured channel id degrades to no_email_channel instead of throwing', async () => {
    mocks.getUserConfig.mockResolvedValue({ digest_channel_account_id: 999, default_test_email: 'me@example.com' });
    mocks.resolveEmailAccount.mockRejectedValue(new Error('指定的通知渠道账号不存在或未激活'));

    const result = await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    expect(result.emailed).toBe(false);
    expect(result.reason).toBe('no_email_channel');
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
  });
});

describe('preview', () => {
  it('with no email channel: still returns REAL data plus a no_email_channel reason', async () => {
    mocks.getUserConfig.mockResolvedValue({ default_test_email: 'me@example.com' });
    mocks.resolveEmailAccount.mockRejectedValue(new Error('请先配置邮件通知渠道（Resend 或 SMTP）'));

    const preview = await buildDigestPreview(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    expect(preview.reason).toBe('no_email_channel');
    expect(preview.channel.configured).toBe(false);
    expect(preview.data.upcoming[0]?.name).toBe('妈妈生日');
    expect(preview.recipients).toEqual(['me@example.com']);
    expect(preview.isEmpty).toBe(false);
    // No side effects: preview never sends or writes the inbox.
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
  });

  it('with a channel: reports the resolved channel and recipient source', async () => {
    mocks.getUserConfig.mockResolvedValue({ default_test_email: 'me@example.com' });

    const preview = await buildDigestPreview(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    expect(preview.reason).toBeUndefined();
    expect(preview.channel).toMatchObject({ configured: true, name: 'Resend', type: 'resend' });
    expect(preview.recipientSource).toBe('resolved');
  });

  it('honors unsaved form overrides so toggling a section reflects immediately', async () => {
    mocks.getUserConfig.mockResolvedValue({ default_test_email: 'me@example.com' });

    const preview = await buildDigestPreview(1, 'monthly', new Date('2026-10-15T00:00:00Z'), {
      sections: ['overdue'],
      recipients: ['live@example.com'],
    });

    expect(preview.sections).toEqual(['overdue']);
    expect(preview.data.overdue).toHaveLength(1);
    expect(preview.data.upcoming).toHaveLength(0);
    expect(preview.recipients).toEqual(['live@example.com']);
    expect(preview.recipientSource).toBe('override');
  });
});

describe('section helpers', () => {
  const baseData: DigestData = {
    userId: 1,
    period: 'monthly',
    from: '2026-09-01',
    to: '2026-09-30',
    today: '2026-10-01',
    upcoming: [{ id: 1, name: 'x', type: 'birthday', date: '2026-10-05' }],
    overdue: [{ kind: 'expiry', title: 'y', due: '2026-09-20', daysOverdue: 11 }],
    spend: { from: '2026-09-01', to: '2026-09-30', byCurrency: { CNY: 100 }, onceByCurrency: {}, onceCount: 0, byKind: [] },
    habits: [{ name: 'h', logged: 1, target: 2, rate: 50 }],
    medications: { taken: 1, skipped: 0, missed: 0, total: 1, percentage: 100, perMedication: [] },
    maintenance: [{ assetName: 'm', due: '2026-10-15', overdue: false }],
    goals: [{ title: 'g', status: 'active', progress: 40, milestonesDone: 1, milestonesTotal: 2 }],
    isEmpty: false,
  };

  it('null / [] means all sections', () => {
    expect(selectDigestSections(baseData, null)).toBe(baseData);
    expect(selectDigestSections(baseData, []).upcoming).toHaveLength(1);
  });

  it('keeps only the selected section and recomputes isEmpty', () => {
    const onlyGoals = selectDigestSections(baseData, ['goals']);
    expect(onlyGoals.upcoming).toHaveLength(0);
    expect(onlyGoals.goals).toHaveLength(1);
    expect(onlyGoals.isEmpty).toBe(false);

    const noneValid = selectDigestSections(baseData, ['goals']);
    expect(noneValid.medications.total).toBe(0);
  });

  it('normalizeDigestSections filters unknown keys and canonicalizes empty to null', () => {
    expect(normalizeDigestSections(['goals', 'bogus', 'goals'])).toEqual(['goals']);
    expect(normalizeDigestSections([])).toBeNull();
    expect(normalizeDigestSections(['bogus'])).toBeNull();
    expect(normalizeDigestSections(null)).toBeNull();
  });
});
