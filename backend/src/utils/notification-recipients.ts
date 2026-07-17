import { query } from '../db/index.js';

const EMAIL_CHANNEL_TYPES = new Set(['email', 'resend', 'smtp']);

/** Resolve recipient email for channel test / health check (channel chat_id → default_test_email). */
export async function resolveEmailRecipientForTest(
  userId: number,
  channelType: string,
  chatId?: string | null,
): Promise<string | undefined> {
  const trimmed = chatId?.trim();
  if (trimmed && trimmed.includes('@')) return trimmed.toLowerCase();
  if (!EMAIL_CHANNEL_TYPES.has(channelType)) return trimmed || undefined;

  const cfg = await query(
    'SELECT default_test_email FROM user_configs WHERE user_id = $1',
    [userId],
  );
  const fallback = cfg.rows[0]?.default_test_email as string | undefined;
  return fallback?.trim() || undefined;
}
