import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 97 / defect D3: `/profile <name>` claimed success but persisted NOTHING.
 *
 * Checkbox 94 DID create `bot_links`; the old `setActiveProfile` was an empty seam, so
 * `bot_links.active_profile_id` stayed NULL and the next `/list` was not scoped. The fix
 * persists the id on the caller's link row (validating that the profile belongs to the user
 * and is active) and reports `invalid_profile` / `not_linked` honestly instead of a fake
 * success. `resolveActingChatContext` then feeds the persisted id into the next command.
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import {
  dispatchCommand,
  LINK_REQUIRED_REPLY,
  type BotChatRef,
  type BotDataProvider,
} from '../services/bot/dispatcher.js';
import {
  getActiveBotLink,
  setBotLinkActiveProfile,
} from '../services/bot/linking.service.js';
import { resolveActingChatContext } from '../services/bot/telegram-webhook.js';
import { defaultBotDataProvider } from '../services/bot/bot-data.service.js';
import { escapeMarkdownV2, validateMarkdownV2 } from '../services/bot/markdown.js';

interface ProfileRow {
  id: number;
  user_id: number;
  name: string;
  kind: string;
  is_active: boolean;
  sort_order: number;
}
interface LinkRow {
  id: number;
  user_id: number;
  platform: string;
  chat_id: string;
  chat_type: string | null;
  revoked_at: Date | null;
  active_profile_id: number | null;
}
interface EventRow {
  id: number;
  user_id: number;
  name: string;
  date: string;
  profile_id: number | null;
}

const CHAT: BotChatRef = { platform: 'telegram', chatId: '555001' };

const state: {
  profiles: ProfileRow[];
  links: LinkRow[];
  events: EventRow[];
  captured: Array<{ sql: string; params: unknown[] }>;
} = { profiles: [], links: [], events: [], captured: [] };

function installDb(): void {
  state.profiles = [
    { id: 1, user_id: 1, name: '我', kind: 'self', is_active: true, sort_order: 0 },
    { id: 2, user_id: 1, name: '工作', kind: 'family', is_active: true, sort_order: 1 },
    { id: 3, user_id: 2, name: '别人的档案', kind: 'family', is_active: true, sort_order: 2 },
  ];
  state.links = [
    {
      id: 1,
      user_id: 1,
      platform: 'telegram',
      chat_id: CHAT.chatId,
      chat_type: 'private',
      revoked_at: null,
      active_profile_id: null,
    },
  ];
  state.events = [
    { id: 11, user_id: 1, name: '工作事项', date: '2026-10-05', profile_id: 2 },
    { id: 12, user_id: 1, name: '早会', date: '2026-10-05', profile_id: null },
  ];
  state.captured = [];

  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.captured.push({ sql: s, params });

    if (s.includes('FROM bot_links') && s.startsWith('SELECT')) {
      const [platform, chatId] = params;
      const link = state.links.find(
        (l) => l.platform === platform && l.chat_id === chatId && l.revoked_at === null,
      );
      return { rows: link ? [link] : [], rowCount: link ? 1 : 0 };
    }
    if (s.startsWith('SELECT * FROM profiles')) {
      const userId = Number(params[0]);
      const activeOnly = s.includes('is_active = TRUE');
      const rows = state.profiles
        .filter((p) => p.user_id === userId && (!activeOnly || p.is_active))
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      return { rows, rowCount: rows.length };
    }
    if (s.includes('WITH target AS')) {
      const [platform, chatId, profileId, userId] = params as [string, string, number, number];
      const hasProfile = state.profiles.some(
        (p) => p.id === profileId && p.user_id === userId && p.is_active,
      ) ? 1 : 0;
      const link = state.links.find(
        (l) =>
          l.platform === platform &&
          l.chat_id === chatId &&
          l.revoked_at === null &&
          l.user_id === userId,
      );
      const updated = hasProfile && link ? 1 : 0;
      if (hasProfile && link) link.active_profile_id = profileId;
      return { rows: [{ has_profile: hasProfile, updated }], rowCount: 1 };
    }
    if (s.includes('FROM events e')) {
      const userId = Number(params[0]);
      const profileId = params[1] == null ? null : Number(params[1]);
      const rows = state.events
        .filter((e) => e.user_id === userId && (profileId === null || e.profile_id === profileId))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function ctx(profileId: number | null, text: string) {
  return { platform: 'telegram' as const, chatId: CHAT.chatId, userId: 1, profileId, text };
}

function dispatch(profileId: number | null, text: string, isLinked = true) {
  return dispatchCommand(ctx(profileId, text), {
    provider: defaultBotDataProvider,
    isLinked: async () => isLinked,
    now: () => new Date('2026-10-05T02:00:00Z'),
    audit: async () => undefined,
  });
}

beforeEach(() => {
  installDb();
});

describe('setBotLinkActiveProfile (atomic link+profile validation)', () => {
  it('writes the id when the link is active and the profile belongs to the user', async () => {
    await expect(setBotLinkActiveProfile({ ...CHAT, userId: 1, profileId: 2 })).resolves.toBe('ok');
    expect(state.links[0].active_profile_id).toBe(2);
    const update = state.captured.find((c) => c.sql.includes('WITH target AS'));
    expect(update?.sql).toContain('UPDATE bot_links');
    expect(update?.sql).toContain('active_profile_id = $3');
    expect(update?.params).toEqual(['telegram', CHAT.chatId, 2, 1]);
  });

  it('refuses another user\'s profile and an inactive profile with invalid_profile', async () => {
    await expect(setBotLinkActiveProfile({ ...CHAT, userId: 1, profileId: 3 })).resolves.toBe('invalid_profile');
    state.profiles[1].is_active = false;
    await expect(setBotLinkActiveProfile({ ...CHAT, userId: 1, profileId: 2 })).resolves.toBe('invalid_profile');
    expect(state.links[0].active_profile_id).toBeNull();
  });

  it('refuses a chat without an active link with not_linked', async () => {
    await expect(
      setBotLinkActiveProfile({ platform: 'telegram', chatId: '999999', userId: 1, profileId: 2 }),
    ).resolves.toBe('not_linked');
    state.links[0].revoked_at = new Date();
    await expect(setBotLinkActiveProfile({ ...CHAT, userId: 1, profileId: 2 })).resolves.toBe('not_linked');
  });
});

describe('defaultBotDataProvider.setActiveProfile (D3 malformed ids)', () => {
  it.each([null, 0, -1, 1.5, Number.NaN])('refuses profileId=%s without a write', async (bad) => {
    const result = await defaultBotDataProvider.setActiveProfile(1, bad as number | null, CHAT);
    expect(result).toBe('invalid_profile');
    expect(state.captured.some((c) => c.sql.includes('UPDATE bot_links'))).toBe(false);
  });
});

describe('dispatchCommand /profile (D3)', () => {
  it('persists the active profile and scopes the next /list to it', async () => {
    const reply = await dispatch(null, '/profile 工作');
    expect(reply?.text).toBe('✅ 已切换到档案：工作');
    expect(reply?.markdownText).toBe('✅ 已切换到档案：工作');
    expect(state.links[0].active_profile_id).toBe(2);

    // The next command resolves the profile FROM the persisted link (as the webhook does).
    const acting = await resolveActingChatContext('telegram', CHAT.chatId);
    expect(acting).toEqual({ userId: 1, profileId: 2, linked: true });
    expect((await getActiveBotLink('telegram', CHAT.chatId))?.activeProfileId).toBe(2);

    const listed = await dispatch(acting?.profileId ?? null, '/list');
    expect(listed?.text).toContain('工作事项');
    expect(listed?.text).not.toContain('早会');
    const listQuery = state.captured.find((c) => c.sql.includes('FROM events e') && c.sql.includes('ORDER BY e.date ASC'));
    expect(listQuery?.params).toEqual([1, 2]);
  });

  it('refuses an unknown (or inactive) profile with a clear message and no write', async () => {
    const reply = await dispatch(null, '/profile 不存在');
    expect(reply?.kind).toBe('error');
    expect(reply?.text).toContain('未找到档案');
    expect(state.links[0].active_profile_id).toBeNull();
  });

  it('refuses an unlinked chat with the link-required reply and no write', async () => {
    const reply = await dispatch(null, '/profile 工作', false);
    expect(reply?.text).toBe(LINK_REQUIRED_REPLY.text);
    expect(reply?.data).toBeUndefined();
    expect(state.links[0].active_profile_id).toBeNull();
  });

  it('maps a data-layer invalid_profile / not_linked outcome to an honest reply', async () => {
    const base: BotDataProvider = {
      ...defaultBotDataProvider,
      listProfiles: async () => [{ id: 2, name: '工作', isDefault: false }],
    };
    const invalid = await dispatchCommand(ctx(null, '/profile 工作'), {
      provider: { ...base, setActiveProfile: async () => 'invalid_profile' },
      isLinked: async () => true,
      audit: async () => undefined,
    });
    expect(invalid?.kind).toBe('error');
    expect(invalid?.text).toContain('不可用');

    const unlinked = await dispatchCommand(ctx(null, '/profile 工作'), {
      provider: { ...base, setActiveProfile: async () => 'not_linked' },
      isLinked: async () => true,
      audit: async () => undefined,
    });
    expect(unlinked?.text).toBe(LINK_REQUIRED_REPLY.text);
  });

  it('escapes MarkdownV2 metacharacters in a profile name (prompt injection)', async () => {
    state.profiles.push({
      id: 9,
      user_id: 1,
      name: '工作_*[测试](x)',
      kind: 'family',
      is_active: true,
      sort_order: 5,
    });
    const reply = await dispatch(null, '/profile 工作_*[测试](x)');
    expect(reply?.text).toBe('✅ 已切换到档案：工作_*[测试](x)');
    expect(reply?.markdownText).toContain(escapeMarkdownV2('工作_*[测试](x)'));
    expect(reply?.markdownText).not.toContain('工作_*[测试](x)');
    expect(validateMarkdownV2(String(reply?.markdownText))).toEqual([]);
  });
});
