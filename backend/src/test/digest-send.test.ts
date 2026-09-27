import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 79 — digest delivery contract (mocked collaborators).
 *
 * Proves: the PDF is attached, the mail is sent EXACTLY ONCE per invocation, the
 * Inbox message is always written, zero recipients / no email channel degrade
 * gracefully, and the seeded section counts reach the rendered body. The real SQL
 * aggregation is proven separately by the PGlite live harness.
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

import { sendDigestForUser, sendDigestsForAllUsers } from '../services/digest.service.js';

const EMPTY_SPEND = {
  totalCents: 0,
  currency: null,
  mixedCurrencies: false,
  byCurrency: {},
  byKind: [],
  monthly: [],
  once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
};

function installDb(overrides: { empty?: boolean } = {}): void {
  mocks.dbQuery.mockReset();
  mocks.dbQuery.mockImplementation(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (overrides.empty) return { rows: [], rowCount: 0 };
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

describe('sendDigestForUser — email + inbox', () => {
  it('sends EXACTLY ONE email (recipients merged) with a PDF attachment and one inbox message', async () => {
    const result = await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));

    expect(mocks.sendRawEmail).toHaveBeenCalledTimes(1);
    const [creds, to, subject, , attachments] = mocks.sendRawEmail.mock.calls[0] as [unknown, string[], string, string, Array<{ filename: string; content: Uint8Array }>];
    expect(creds).toMatchObject({ type: 'resend' });
    expect(to).toEqual(['me@example.com']);
    expect(String(subject)).toContain('月度');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('timemark-digest-monthly-2026-09-30.pdf');
    expect(Buffer.from(attachments[0].content).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    expect(mocks.createInboxMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ emailed: true, recipients: ['me@example.com'], inbox: true, from: '2026-09-01', to: '2026-09-30' });
  });

  it('renders every section count into the emailed body', async () => {
    await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    const html = String((mocks.sendRawEmail.mock.calls[0] as [unknown, unknown, unknown, string])[3]);

    expect(html).toContain('妈妈生日');
    expect(html).toContain('域名续费');
    expect(html).toContain('晨跑');
    expect(html).toContain('布洛芬');
    expect(html).toContain('洗碗机');
    expect(html).toContain('读完 12 本书');
    expect(html).toContain('¥10.00');
  });

  it('a zero-data account still emails a valid 本期无记录 digest', async () => {
    installDb({ empty: true });
    mocks.getAdherence.mockResolvedValue({ from: '2026-09-01', to: '2026-09-30', overall: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, currentStreak: 0 }, medications: [] });
    mocks.getExpiryCosts.mockResolvedValue(EMPTY_SPEND);

    const result = await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    expect(result.emailed).toBe(true);
    const html = String((mocks.sendRawEmail.mock.calls[0] as [unknown, unknown, unknown, string])[3]);
    expect(html).toContain('本期无记录');
    expect(html.length).toBeGreaterThan(200);
  });

  it('with no resolvable recipient: no email, but the inbox message still happens', async () => {
    mocks.resolveRecipientEmails.mockReturnValue([]);
    mocks.getUserConfig.mockResolvedValue({});
    mocks.getNotificationAccounts.mockResolvedValue([]);

    const result = await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
    expect(mocks.createInboxMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ emailed: false, reason: 'no_email_recipient', inbox: true });
  });

  it('with a recipient but no email channel: reports no_email_channel, no send', async () => {
    mocks.resolveEmailAccount.mockRejectedValue(new Error('请先配置邮件通知渠道（Resend 或 SMTP）'));
    const result = await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    expect(mocks.sendRawEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ emailed: false, reason: 'no_email_channel' });
  });

  it('prompt/header injection in a section name is escaped in the body and never reaches the subject', async () => {
    mocks.dbQuery.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM goals g')) {
        return { rows: [{ id: 1, title: '</td><script>alert(1)</script>\r\nBcc: evil@x', status: 'active', target_value: 10, current_value: 4, milestone_total: 1, milestone_done: 0 }], rowCount: 1 };
      }
      if (s.includes('FROM users')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await sendDigestForUser(1, 'monthly', new Date('2026-10-15T00:00:00Z'));
    const [, , subject, html] = mocks.sendRawEmail.mock.calls[0] as [unknown, unknown, string, string];
    expect(subject).toBe('TimeMark 月度摘要 · 2026-09-30');
    expect(subject).not.toContain('Bcc');
    expect(html).toContain('&lt;/td&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('sendDigestsForAllUsers', () => {
  it('iterates every user and counts delivered digests', async () => {
    const batch = await sendDigestsForAllUsers('monthly', new Date('2026-10-15T00:00:00Z'));
    expect(batch).toMatchObject({ period: 'monthly', users: 2, sent: 2, skipped: 0 });
    expect(mocks.sendRawEmail).toHaveBeenCalledTimes(2);
    expect(mocks.createInboxMessage).toHaveBeenCalledTimes(2);
  });
});
