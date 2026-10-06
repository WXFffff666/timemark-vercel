import { query } from '../db/index.js';

const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_SENDER = 100;

export type InboxSource = 'inbound' | 'notification' | 'broadcast';

export interface InboxMessageRow {
  id: number;
  user_id: number;
  title: string;
  body: string;
  source: InboxSource;
  channel: string | null;
  event_id: number | null;
  sender_label: string | null;
  is_read: boolean;
  created_at: string;
}

function sanitizeText(input: string, maxLen: number): string {
  return input
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex -- intentionally strips ASCII control characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
    .slice(0, maxLen);
}

export async function createInboxMessage(params: {
  userId: number;
  title: string;
  body: string;
  source: InboxSource;
  channel?: string | null;
  eventId?: number | null;
  senderLabel?: string | null;
}): Promise<InboxMessageRow | null> {
  const title = sanitizeText(params.title, MAX_TITLE);
  const body = sanitizeText(params.body, MAX_BODY);
  if (!title || !body) return null;

  const senderLabel = params.senderLabel
    ? sanitizeText(params.senderLabel, MAX_SENDER)
    : null;

  const result = await query(
    `INSERT INTO inbox_messages (user_id, title, body, source, channel, event_id, sender_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.userId,
      title,
      body,
      params.source,
      params.channel ?? null,
      params.eventId ?? null,
      senderLabel,
    ],
  );
  return result.rows[0] as InboxMessageRow;
}

export async function listInboxMessages(
  userId: number,
  options: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
    q?: string;
    since?: string;
    /** v2.30：来源标签页。默认 'all'——broadcast 是用户自己的消息（cron 告警、摘要归档等），没理由藏起来 */
    source?: 'all' | 'inbound' | 'broadcast';
  } = {},
): Promise<{ messages: InboxMessageRow[]; total: number; unreadCount: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const unreadOnly = options.unreadOnly === true;
  const source = options.source ?? 'all';

  // v2.30：来源可选（all/inbound/broadcast）。此前硬编码只看 inbound，
  // 广播类消息（cron 告警、摘要归档）在 UI 里是死信。
  // 全静态 SQL：条件用占位符 + NULL 旁路表达，不拼接任何用户输入。
  const baseParams: unknown[] = [
    userId,
    source === 'all' ? null : source, // $2: 来源过滤，NULL = 不过滤
    unreadOnly, // $3: 只看未读
    options.q?.trim() ? `%${options.q.trim()}%` : null, // $4: 文本搜索
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(options.since ?? '') ? options.since : null, // $5: 增量
  ];
  const listSql = `SELECT * FROM inbox_messages
     WHERE user_id = $1
       AND ($2::text IS NULL OR source = $2::text)
       AND ($3::boolean = FALSE OR is_read = FALSE)
       AND ($4::text IS NULL OR title ILIKE $4 OR body ILIKE $4)
       AND ($5::text IS NULL OR created_at > $5::timestamptz)
     ORDER BY created_at DESC LIMIT $6 OFFSET $7`;
  const countSql = `SELECT COUNT(*)::int AS total FROM inbox_messages
     WHERE user_id = $1
       AND ($2::text IS NULL OR source = $2::text)
       AND ($3::boolean = FALSE OR is_read = FALSE)
       AND ($4::text IS NULL OR title ILIKE $4 OR body ILIKE $4)
       AND ($5::text IS NULL OR created_at > $5::timestamptz)`;

  // 未读数始终按全部来源统计（徽标语义 = 有没看过的消息）
  const [listResult, countResult, unreadResult] = await Promise.all([
    query(listSql, [...baseParams, limit, offset]),
    query(countSql, baseParams),
    query(`SELECT COUNT(*)::int AS unread FROM inbox_messages WHERE user_id = $1 AND is_read = FALSE`, [userId]),
  ]);

  return {
    messages: listResult.rows as InboxMessageRow[],
    total: countResult.rows[0]?.total ?? 0,
    unreadCount: unreadResult.rows[0]?.unread ?? 0,
  };
}

export async function markInboxRead(userId: number, messageId: number): Promise<boolean> {
  const result = await query(
    `UPDATE inbox_messages SET is_read = TRUE
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [messageId, userId],
  );
  return result.rows.length > 0;
}

export async function markAllInboxRead(userId: number): Promise<number> {
  const result = await query(
    `UPDATE inbox_messages SET is_read = TRUE
     WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export async function deleteInboxMessage(userId: number, messageId: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM inbox_messages WHERE id = $1 AND user_id = $2 RETURNING id`,
    [messageId, userId],
  );
  return result.rows.length > 0;
}

/** v2.30：批量操作。ids 走整型数组单参数（ANY($2::int[])），无字符串拼接。 */
export async function batchMarkInboxRead(userId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await query(
    `UPDATE inbox_messages SET is_read = TRUE WHERE user_id = $1 AND id = ANY($2::int[]) RETURNING id`,
    [userId, ids],
  );
  return result.rows.length;
}

export async function batchDeleteInboxMessages(userId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await query(
    `DELETE FROM inbox_messages WHERE user_id = $1 AND id = ANY($2::int[]) RETURNING id`,
    [userId, ids],
  );
  return result.rows.length;
}

export async function purgeOldInboxMessages(): Promise<number> {
  const result = await query(
    `DELETE FROM inbox_messages WHERE created_at < NOW() - INTERVAL '30 days'`,
  );
  return result.rowCount ?? 0;
}

export async function getInboxReceiveTokens(userId: number): Promise<{
  inboxReceiveToken: string | null;
  inboxReceiveSecret: string | null;
}> {
  const row = await query(
    `SELECT inbox_receive_token, inbox_receive_secret FROM user_configs WHERE user_id = $1`,
    [userId],
  );
  const r = row.rows[0] || {};
  if (r.inbox_receive_token) {
    return { inboxReceiveToken: r.inbox_receive_token, inboxReceiveSecret: r.inbox_receive_secret ?? null };
  }
  // v2.30 修复：v23 迁移只为当时已存在的 user_configs 行补过一次 token，
  // 之后才创建的用户（全新安装的 admin bootstrap 正是这样）永远拿不到收件地址。
  // 改为按需生成，幂等补齐；COALESCE 防并发双写。
  const { randomBytes } = await import('crypto');
  const token = randomBytes(24).toString('hex');
  const secret = randomBytes(32).toString('hex');
  await query(
    `UPDATE user_configs SET
       inbox_receive_token = COALESCE(inbox_receive_token, $1),
       inbox_receive_secret = COALESCE(inbox_receive_secret, $2)
     WHERE user_id = $3`,
    [token, secret, userId],
  );
  return { inboxReceiveToken: token, inboxReceiveSecret: secret };
}
