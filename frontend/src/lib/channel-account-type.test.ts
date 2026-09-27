import { describe, expect, it } from 'vitest';
import { channelToAccountTypeFor } from './channel-account-type';
import { ACCOUNT_TYPE_TO_CHANNEL } from './contact-event-bridge';

/**
 * Checkbox 22 follow-up: EventForm's picker disabled every Wave-2 channel because its inline
 * channel→account-type map did not know the new ids. `channelToAccountTypeFor` is the extracted,
 * testable mapping; it must mirror backend `channelToAccountType` for the new channels
 * (identity: account type === channel id).
 */
const NEW_CHANNEL_IDS = [
  'serverchan3',
  'xizhi',
  'anpush',
  'chanify',
  'pushback',
  'simplepush',
  'zulip',
  'rocketchat',
  'fcm',
  'twilio_whatsapp',
] as const;

function newChannelAccounts(): Array<{ type: string; is_active: boolean; last_test_result: 'success' | 'failed' | null }> {
  return NEW_CHANNEL_IDS.map((id) => ({ type: id, is_active: true, last_test_result: null }));
}

/** Mirrors the exact picker computation in EventForm.tsx (accountType → configuredAccounts → isDisabled). */
function pickerState(
  channelId: string,
  accounts: Array<{ type: string; is_active: boolean; last_test_result: 'success' | 'failed' | null }>,
): { accountType: string | undefined; configuredAccounts: typeof accounts; isConfigured: boolean; isDisabled: boolean } {
  const accountType = channelToAccountTypeFor(channelId);
  const configuredAccounts = accounts.filter((a) => a.type === accountType);
  const isConfigured = configuredAccounts.length > 0;
  return { accountType, configuredAccounts, isConfigured, isDisabled: !isConfigured };
}

describe('channelToAccountTypeFor (picker mapping)', () => {
  it('resolves every new channel id to its own account type', () => {
    for (const id of NEW_CHANNEL_IDS) {
      expect(channelToAccountTypeFor(id), `channel ${id}`).toBe(id);
    }
  });

  it('keeps the legacy mappings unchanged (extraction must not alter existing behavior)', () => {
    expect(channelToAccountTypeFor('email')).toBe('email');
    expect(channelToAccountTypeFor('smtp')).toBe('smtp');
    expect(channelToAccountTypeFor('nextcloud_talk')).toBe('nextcloudtalk');
    expect(channelToAccountTypeFor('serverchan')).toBe('serverchan');
    expect(channelToAccountTypeFor('wxpusher')).toBe('wxpusher');
    expect(channelToAccountTypeFor('apprise')).toBe('apprise');
  });

  it('returns undefined for an unknown channel id', () => {
    expect(channelToAccountTypeFor('__not_a_channel__')).toBeUndefined();
  });

  it('enables a picker button only when a matching account exists (configuredAccounts/isDisabled)', () => {
    const accounts = newChannelAccounts();

    for (const id of NEW_CHANNEL_IDS) {
      const configured = pickerState(id, accounts);
      expect(configured.isDisabled, `${id} with a configured account`).toBe(false);
      expect(configured.configuredAccounts).toHaveLength(1);
    }

    const withoutZulip = accounts.filter((a) => a.type !== 'zulip');
    const missing = pickerState('zulip', withoutZulip);
    expect(missing.isDisabled).toBe(true);
    expect(missing.configuredAccounts).toHaveLength(0);
  });
});

describe('ACCOUNT_TYPE_TO_CHANNEL (contact → channel binding)', () => {
  it('maps all 10 new account types back to their channel values', () => {
    for (const id of NEW_CHANNEL_IDS) {
      expect(ACCOUNT_TYPE_TO_CHANNEL[id], `account type ${id}`).toBe(id);
    }
  });
});
