import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 97 / defect D4: `/med` rendered the UTC clock (`scheduledFor.slice(11, 16)`)
 * instead of the user's local time - a dose stored at 09:00 (+08) showed as 01:00.
 *
 * The data layer now formats the local `HH:mm` (`BotDoseItem.localTime`) in the SAME
 * timezone the doses were materialised in, and the dispatcher renders that value. The two
 * timezone fixtures below prove the rendering is not hardcoded +08.
 */

const { dbQuery, medState } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  medState: {
    timezone: 'Asia/Shanghai',
    doses: [] as Array<{ id: number; medication: { name: string }; scheduled_for: string; status: string }>,
  },
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/medication.service.js', () => ({
  getMedicationTimezone: vi.fn(async () => medState.timezone),
  getTodayDoses: vi.fn(async () => medState.doses),
}));

import {
  dispatchCommand,
  type BotDataProvider,
} from '../services/bot/dispatcher.js';
import { defaultBotDataProvider } from '../services/bot/bot-data.service.js';

const DOSE_09_SHANGHAI = '2026-09-28T01:00:00.000Z'; // 09:00 Asia/Shanghai / 21:00 New York (prev day)
const DOSE_MIDNIGHT = '2026-09-28T16:00:00.000Z'; // 00:00 Asia/Shanghai next day

function dose(scheduledFor: string, name = '维生素D') {
  return { id: 1, medication: { name }, scheduled_for: scheduledFor, status: 'pending' };
}

function dispatchMed(provider: BotDataProvider, profileId: number | null = null) {
  return dispatchCommand(
    { platform: 'telegram', chatId: '555001', userId: 1, profileId, text: '/med' },
    { provider, isLinked: async () => true, audit: async () => undefined },
  );
}

beforeEach(() => {
  medState.timezone = 'Asia/Shanghai';
  medState.doses = [dose(DOSE_09_SHANGHAI)];
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('BotDoseItem.localTime (D4 data layer)', () => {
  it('renders 09:00 for a 01:00Z dose under Asia/Shanghai', async () => {
    medState.timezone = 'Asia/Shanghai';
    const items = await defaultBotDataProvider.listTodayDoses(1, null);
    expect(items).toEqual([
      { id: 1, medicationName: '维生素D', scheduledFor: DOSE_09_SHANGHAI, localTime: '09:00', status: 'pending' },
    ]);
  });

  it('renders 21:00 (previous day) for the same instant under America/New_York - not hardcoded +08', async () => {
    medState.timezone = 'America/New_York';
    const items = await defaultBotDataProvider.listTodayDoses(1, null);
    expect(items[0]?.localTime).toBe('21:00');
    expect(items[0]?.localTime).not.toBe('09:00');
  });

  it('renders midnight as 00:00 (no 24:00 hour-cycle artefact)', async () => {
    medState.timezone = 'Asia/Shanghai';
    medState.doses = [dose(DOSE_MIDNIGHT)];
    const items = await defaultBotDataProvider.listTodayDoses(1, null);
    expect(items[0]?.localTime).toBe('00:00');
  });
});

describe('handleMed renders the local clock (D4 dispatcher)', () => {
  it('shows 09:00 (not the UTC 01:00) under Asia/Shanghai', async () => {
    medState.timezone = 'Asia/Shanghai';
    const reply = await dispatchMed(defaultBotDataProvider);
    expect(reply?.text).toContain('09:00');
    expect(reply?.text).toContain('维生素D');
    expect(reply?.text).not.toContain('01:00');
  });

  it('shows the New York clock under America/New_York', async () => {
    medState.timezone = 'America/New_York';
    const reply = await dispatchMed(defaultBotDataProvider);
    expect(reply?.text).toContain('21:00');
    expect(reply?.text).not.toContain('01:00');
    expect(reply?.text).not.toContain('09:00');
  });
});
