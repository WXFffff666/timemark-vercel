import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 108 — the digest narrative wired into task 79.
 *
 * Proves the byte-identity contract: with the feature off (the shipped default) the
 * emailed digest body is byte-for-byte the deterministic render; with the feature on and
 * a valid narrative it is prepended; with a rejected narrative (summarize returns null)
 * the deterministic digest is rendered and the fabricated total is absent.
 *
 * `../services/ai/summarize.js` is mocked so the digest service's behaviour is asserted
 * without a provider; the summarizer's own guard/cache logic is proven in
 * `ai-summarize.test.ts` against the real gateway.
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
  summarizeDigestNarrative: vi.fn(),
  isDigestNarrativeEnabled: vi.fn(),
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
vi.mock('../services/ai/summarize.js', () => ({
  summarizeDigestNarrative: mocks.summarizeDigestNarrative,
  isDigestNarrativeEnabled: mocks.isDigestNarrativeEnabled,
}));

import { buildDigestData, renderDigestHtml, sendDigestForUser } from '../services/digest.service.js';

const NOW = new Date('2026-10-15T00:00:00Z');

function installDb(): void {
  mocks.dbQuery.mockReset();
  mocks.dbQuery.mockImplementation(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM events')) return { rows: [{ id: 1, name: '妈妈生日', type: 'birthday', occurrence: '2026-10-05' }], rowCount: 1 };
    if (s.includes("'expiry' AS kind")) return { rows: [{ kind: 'expiry', title: '域名续费', due: '2026-09-20' }], rowCount: 1 };
    if (s.includes('FROM habits h')) return { rows: [{ id: 1, name: '晨跑', target_per_period: 1, period: 'day', schedule_days: null, logged: 3 }], rowCount: 1 };
    if (s.includes('FROM maintenance_plans')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM goals g')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM users')) return { rows: [{ id: 1 }], rowCount: 1 };
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
    totalCents: 1000,
    currency: 'CNY',
    mixedCurrencies: false,
    byCurrency: { CNY: 1000 },
    byKind: [],
    monthly: [],
    once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
  });
  mocks.createInboxMessage.mockResolvedValue({ id: 9 });
  mocks.getNotificationAccounts.mockResolvedValue([
    { id: 1, user_id: 1, type: 'resend', name: 'Resend', chat_id: null, is_active: true },
  ]);
  mocks.getUserConfig.mockResolvedValue({ default_test_email: 'me@example.com', reminder_emails: [] });
  mocks.resolveRecipientEmails.mockReturnValue(['me@example.com']);
  mocks.resolveEmailAccount.mockResolvedValue({ id: 1, type: 'resend', name: 'Resend', apiKey: 're_x', fromEmail: 'from@example.com' });
  mocks.sendRawEmail.mockResolvedValue(undefined);
}

function emailedHtml(): string {
  return String((mocks.sendRawEmail.mock.calls[0] as [unknown, unknown, unknown, string])[3]);
}

beforeEach(() => {
  installDb();
  installCollaborators();
  mocks.summarizeDigestNarrative.mockReset();
  mocks.isDigestNarrativeEnabled.mockReset();
});

describe('digest narrative wiring (checkbox 108)', () => {
  it('WITH AI DISABLED the emailed digest is byte-identical to task 79\u2019s deterministic render', async () => {
    mocks.isDigestNarrativeEnabled.mockReturnValue(false);
    mocks.summarizeDigestNarrative.mockResolvedValue({ narrative: null, usedAi: false });

    await sendDigestForUser(1, 'monthly', NOW);
    const actual = emailedHtml();
    const expected = renderDigestHtml(await buildDigestData(1, 'monthly', NOW));

    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    expect(actual).toContain('不含 AI 叙述');
    expect(actual).not.toContain('本期叙述');
  });

  it('prepends a valid AI narrative to the email body and the inbox body', async () => {
    mocks.isDigestNarrativeEnabled.mockReturnValue(true);
    mocks.summarizeDigestNarrative.mockResolvedValue({ narrative: '本期用药记录共 3 条，请继续保持。', usedAi: true });

    await sendDigestForUser(1, 'monthly', NOW);
    const html = emailedHtml();
    expect(html).toContain('本期叙述');
    expect(html).toContain('本期用药记录共 3 条，请继续保持。');
    expect(html).toContain('AI');

    const inbox = (mocks.createInboxMessage.mock.calls[0] as [{ body: string }])[0];
    expect(inbox.body).toContain('本期用药记录共 3 条，请继续保持。');
  });

  it('a rejected narrative renders the deterministic digest: only the REAL total, never the fabricated one', async () => {
    mocks.isDigestNarrativeEnabled.mockReturnValue(true);
    // summarize's numeral guard rejects the fabricated model sentence -> narrative:null.
    mocks.summarizeDigestNarrative.mockResolvedValue({ narrative: null, usedAi: false });

    await sendDigestForUser(1, 'monthly', NOW);
    const html = emailedHtml();
    expect(html).not.toContain('999');
    expect(html).not.toContain('本期叙述');
    expect(html).toContain('布洛芬'); // the real deterministic record is present
    expect(html).toContain('>3<'); // the real medication total from the deterministic stats
  });
});
