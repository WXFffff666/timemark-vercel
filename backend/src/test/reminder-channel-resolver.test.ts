import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 渠道解析优先级与「默认/启用渠道」兜底（wave7d-59 issue 2）。
 *
 * UI 创建的到期项/证件/库存/保养条目默认不带 reminder_config，事件的渠道选择也允许
 * 为空；解析器必须在这种情况下回退到用户已启用的通知账户（notification_accounts.
 * is_active = TRUE 的 type），否则迭代器会静默跳过条目 —— 即使 user 已经配置了渠道。
 *
 * 优先级：条件规则 > 套餐分级 > 事件/条目自身渠道 > 已启用账户兜底。
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import { resolveReminderChannels } from '../services/reminder-channel-resolver.service.js';

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

function installDb(input: {
  rules?: Array<{ days_before: number; channels: unknown }>;
  preset?: string | null;
  accountTypes?: string[];
}): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM conditional_reminder_rules')) {
      return { rows: input.rules ?? [], rowCount: input.rules?.length ?? 0 };
    }
    if (s.includes('notification_preset FROM user_configs')) {
      return { rows: input.preset ? [{ notification_preset: input.preset }] : [], rowCount: input.preset ? 1 : 0 };
    }
    if (s.includes('FROM notification_accounts')) {
      const rows = (input.accountTypes ?? []).map((type) => ({ type }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function accountQueries(): Captured[] {
  return captured.filter((q) => q.sql.includes('FROM notification_accounts'));
}

beforeEach(() => {
  installDb({});
});

describe('resolveReminderChannels - priority', () => {
  it('uses the item/event channels when no rule or preset matches, without touching the account fallback', async () => {
    installDb({ accountTypes: ['generic_webhook'] });

    const channels = await resolveReminderChannels(1, ['email', 'feishu'], 7);

    expect(channels).toEqual(['email', 'feishu']);
    expect(accountQueries()).toHaveLength(0);
  });

  it('lets a matching conditional rule win over preset and item channels', async () => {
    installDb({
      rules: [{ days_before: 7, channels: ['telegram'] }],
      preset: 'balanced',
      accountTypes: ['generic_webhook'],
    });

    const channels = await resolveReminderChannels(1, ['email'], 7);

    expect(channels).toEqual(['telegram']);
  });

  it('lets a matching preset tier win over item channels', async () => {
    installDb({ preset: 'email_focus' });

    const channels = await resolveReminderChannels(1, ['feishu'], 7);

    expect(channels).toEqual(['email', 'resend']);
  });

  it('does not treat an empty rule channel list as a resolution', async () => {
    installDb({ rules: [{ days_before: 7, channels: [] }] });

    const channels = await resolveReminderChannels(1, ['email'], 7);

    expect(channels).toEqual(['email']);
  });
});

describe('resolveReminderChannels - active-account fallback', () => {
  it('falls back to the user active accounts when nothing else resolves (UI-created item with no config)', async () => {
    installDb({ accountTypes: ['generic_webhook', 'resend'] });

    const channels = await resolveReminderChannels(1, [], 7);

    expect(channels).toEqual(['generic_webhook', 'resend']);
    expect(accountQueries()).toHaveLength(1);
    expect(accountQueries()[0].params).toEqual([1]);
  });

  it('filters unsupported account types out of the fallback', async () => {
    installDb({ accountTypes: ['generic_webhook', 'wechat_personal'] });

    const channels = await resolveReminderChannels(1, [], 7);

    expect(channels).toEqual(['generic_webhook']);
  });

  it('returns [] when the user has no active account (nothing can be delivered)', async () => {
    installDb({ accountTypes: [] });

    const channels = await resolveReminderChannels(1, [], 7);

    expect(channels).toEqual([]);
  });

  it('falls back to active accounts when a preset exists but has no tier for this lead day', async () => {
    installDb({ preset: 'balanced', accountTypes: ['generic_webhook'] });

    const channels = await resolveReminderChannels(1, [], 30);

    expect(channels).toEqual(['generic_webhook']);
  });
});
