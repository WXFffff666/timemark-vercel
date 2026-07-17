import { describe, it, expect } from 'vitest';
import { resolveRecipientEmails } from '../services/notifications/index.js';

describe('resolveRecipientEmails', () => {
  it('uses event emailRecipients first', () => {
    const emails = resolveRecipientEmails(
      { reminder_config: { emailRecipients: ['event@test.com'] } },
      { emails: ['channel@test.com'] },
      { default_test_email: 'default@test.com', reminder_emails: ['list@test.com'] },
    );
    expect(emails).toEqual(['event@test.com']);
  });

  it('prefers default_test_email over channel and legacy recipient email', () => {
    expect(
      resolveRecipientEmails(
        { reminder_recipient_email: 'mom@test.com' },
        { emails: ['channel@test.com'] },
        { default_test_email: 'me@test.com' },
      ),
    ).toEqual(['me@test.com']);
  });

  it('falls back to reminder_emails then channel emails', () => {
    expect(
      resolveRecipientEmails({}, { emails: ['ch@test.com'] }, { reminder_emails: ['u@test.com'] }),
    ).toEqual(['u@test.com']);
    expect(
      resolveRecipientEmails({}, { emails: ['ch@test.com'] }, {}),
    ).toEqual(['ch@test.com']);
  });

  it('normalizes email case', () => {
    expect(
      resolveRecipientEmails(
        { reminder_config: { emailRecipients: ['User@Example.COM'] } },
        {},
        {},
      ),
    ).toEqual(['user@example.com']);
  });
});
