import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: mockGet } }));

import { testConnection } from '../test-connection.js';

const VALIDATE_URL = 'https://api.pushover.net/1/users/validate.json';
// Real field mapping (channels.config.ts / index.ts:387-392):
//   notification_accounts.token   = Pushover User Key
//   notification_accounts.secret  = Pushover App Token
//   notification_accounts.chat_id = message priority (-2..2), mapped from the UI "priority" field
const USER_KEY = 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG';
const APP_TOKEN = 'azGDORePK8gMaC0QOYAMyEEuzJnyUi';

describe('Pushover connection test (bug B2)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  it('sends token=<App Token>&user=<User Key> — never the priority', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 1, request: 'ce0f7e91' } });

    const result = await testConnection({
      type: 'pushover',
      configMethod: 'token',
      token: USER_KEY, // account.token = User Key
      secret: APP_TOKEN, // account.secret = App Token
      chatId: '1', // account.chat_id = priority
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe(VALIDATE_URL);
    expect(String(body)).toBe(`token=${APP_TOKEN}&user=${USER_KEY}`);
    expect(String(body)).not.toContain('token=1');
    expect(config).toMatchObject({ timeout: 10000 });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Pushover');
  });

  it('surfaces the provider error body when Pushover rejects the credentials', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { status: 0, errors: ['user key is invalid'] },
    });

    const result = await testConnection({
      type: 'pushover',
      configMethod: 'token',
      token: USER_KEY,
      secret: APP_TOKEN,
      chatId: '1',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('user key is invalid');
  });

  it('fails without an outbound request when the App Token is missing (instead of sending the priority)', async () => {
    const result = await testConnection({
      type: 'pushover',
      configMethod: 'token',
      token: USER_KEY,
      chatId: '1', // only the priority is present
    });

    expect(result.success).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
