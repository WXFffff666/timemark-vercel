import { describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 22: the frontend picker is template-driven — `GET /api/channels/templates` must return
 * every new channel id. Auth is mocked; the route only serializes `getSupportedChannelTemplates()`.
 */
process.env.MASTER_KEY ||= 'wave2-templates-test-master-key';
process.env.JWT_SECRET ||= 'wave2-templates-test-jwt-secret';
process.env.DATABASE_URL ||= 'postgres://127.0.0.1:5432/wave2_test';

vi.mock('../../../middleware/auth.middleware.js', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
vi.mock('../../../db/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));
vi.mock('../../../routes/cron.js', () => ({
  classifyChannelTestResult: vi.fn().mockReturnValue({ status: 'unknown' }),
}));

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
];

const { default: channelsRoutes } = await import('../../../routes/channels.js');

describe('GET /api/channels/templates (checkbox 22)', () => {
  it('returns every new channel id and the authoritative channel count', async () => {
    const response = await channelsRoutes.request('/templates');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean; data: Array<{ id: string }> };
    expect(body.success).toBe(true);
    const ids = body.data.map((template) => template.id);
    for (const id of NEW_CHANNEL_IDS) {
      expect(ids, `templates endpoint is missing ${id}`).toContain(id);
    }
    expect(ids).toHaveLength(42);
  });
});
