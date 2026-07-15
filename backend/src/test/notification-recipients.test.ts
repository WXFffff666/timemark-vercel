import { describe, it, expect } from 'vitest';
import { resolveRecipientEmails } from '../services/notifications/index.js';

describe('resolveRecipientEmails', () => {
  it('uses event reminder_recipient_email first', () => {
    const emails = resolveRecipientEmails(
      { reminder_recipient_email: 'a@test.com' },
      { emails: ['b@test.com'] },
      { default_test_email: 'c@test.com' },
    );
    expect(emails).toEqual(['a@test.com']);
  });

  it('falls back to channel emails then user defaults', () => {
    expect(
      resolveRecipientEmails({}, { emails: ['ch@test.com'] }, { reminder_emails: ['u@test.com'] }),
    ).toEqual(['ch@test.com']);
    expect(
      resolveRecipientEmails({}, {}, { default_test_email: 'd@test.com' }),
    ).toEqual(['d@test.com']);
  });
});
