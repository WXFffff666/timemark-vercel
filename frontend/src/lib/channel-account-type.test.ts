import { describe, expect, it } from 'vitest';
import { accountTypesForChannel, channelForAccountType, isChannelSelected } from './channel-account-type';

/**
 * EventForm's picker used to carry a hand-copied channel→account-type map. Four channels were
 * broken by that copy:
 *
 *   generic_webhook, pushdeer, twilio   -> no entry, so the button was permanently greyed out
 *   nextcloud_talk                      -> mapped to 'nextcloudtalk', but accounts are stored
 *                                         with the template id, so a configured Nextcloud Talk
 *                                         account still looked unconfigured
 *
 * The backend map is identity for every channel except a few legacy aliases, so the whole table
 * is replaced by those aliases. This test is the invariant: no channel id needs to be listed here.
 */
describe('accountTypesForChannel', () => {
  it('treats the channel id as the account type (identity) for every channel', () => {
    for (const id of [
      'email',
      'smtp',
      'resend',
      'nextcloud_talk',
      'generic_webhook',
      'pushdeer',
      'twilio',
      'twilio_whatsapp',
      'serverchan',
      'fcm',
      'zulip',
    ]) {
      expect(accountTypesForChannel(id), `channel ${id}`).toContain(id);
    }
  });

  it('maps the legacy aliases onto the account type that is actually stored', () => {
    expect(accountTypesForChannel('wechat')[0]).toBe('wxpusher');
    expect(accountTypesForChannel('wechat_official')[0]).toBe('wxpusher');
    expect(accountTypesForChannel('qq')[0]).toBe('qmsg');
  });

  it('accepts both spellings of nextcloud talk', () => {
    expect(accountTypesForChannel('nextcloud_talk')).toEqual(['nextcloud_talk', 'nextcloudtalk']);
    expect(accountTypesForChannel('nextcloudtalk')).toEqual(['nextcloud_talk', 'nextcloudtalk']);
  });

  it('never returns an empty list, so an unknown id still matches its own account type', () => {
    expect(accountTypesForChannel('__not_a_channel__')).toEqual(['__not_a_channel__']);
  });
});

describe('channelForAccountType (contact → channel binding)', () => {
  it('returns the canonical channel id the picker actually renders', () => {
    // 这几个账号 type 都会映射回规范渠道，而不是历史别名：
    // 选择器只渲染后端目录里的规范 id，写入 `wechat` 会让用户看不到自己已选的渠道。
    expect(channelForAccountType('wxpusher')).toBe('wxpusher');
    expect(channelForAccountType('qmsg')).toBe('qmsg');
    expect(channelForAccountType('nextcloud_talk')).toBe('nextcloud_talk');
  });

  it('normalises a legacy account type onto the canonical channel', () => {
    expect(channelForAccountType('wechat')).toBe('wxpusher');
    expect(channelForAccountType('wechat_official')).toBe('wxpusher');
    expect(channelForAccountType('qq')).toBe('qmsg');
    expect(channelForAccountType('nextcloudtalk')).toBe('nextcloud_talk');
  });

  it('is identity for everything else, including channels added after this table was written', () => {
    for (const id of ['email', 'fcm', 'pushdeer', 'generic_webhook', 'twilio']) {
      expect(channelForAccountType(id), `account type ${id}`).toBe(id);
    }
  });
});

describe('isChannelSelected (老事件不能因为换了渠道目录就丢配置)', () => {
  it('sees a legacy stored value as its canonical channel', () => {
    expect(isChannelSelected(['wechat'], 'wxpusher')).toBe(true);
    expect(isChannelSelected(['nextcloudtalk'], 'nextcloud_talk')).toBe(true);
    expect(isChannelSelected(['fcm'], 'wxpusher')).toBe(false);
  });

  it('handles an unset config', () => {
    expect(isChannelSelected(undefined, 'wxpusher')).toBe(false);
    expect(isChannelSelected([], 'wxpusher')).toBe(false);
  });
});