import { query } from '../db/index.js';
import type {
  CreateContactPromiseInput,
  CreateGiftRecordInput,
  CreateInteractionInput,
  ContactPromiseRow,
  DueContactRow,
  GiftRecordRow,
  InteractionRow,
  TimelineEntry,
} from '@timemark/shared';

/**
 * 个人 CRM 服务（D4，todo 60/61）。
 *
 * 约定与 expiry.service.ts 相同：
 * - 所有读取按 user_id 限定；「他人的行」与「不存在」都返回 null，由路由映射 404。
 * - 写入用 `INSERT ... SELECT FROM fixed_contacts WHERE id/ user_id` 做原子归属校验，
 *   归属不符时插入 0 行、返回 null（不会泄露联系人的存在性）。
 * - 不发明联系人评分/排名。
 */

/** 该联系人是否属于该用户 */
export async function contactOwnedBy(userId: number, contactId: number): Promise<boolean> {
  const result = await query(
    'SELECT id FROM fixed_contacts WHERE id = $1 AND user_id = $2',
    [contactId, userId],
  );
  return result.rows.length > 0;
}

/**
 * 记录一次互动，并把 `fixed_contacts.last_contact_at` 推进到最新互动时间
 * （只前进不后退；存储列是读取时的回落值，见 listDueContacts）。
 */
export async function createInteraction(
  userId: number,
  contactId: number,
  input: CreateInteractionInput,
): Promise<InteractionRow | null> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const result = await query(
    `INSERT INTO interactions (user_id, contact_id, kind, occurred_at, summary, mood)
     SELECT fc.user_id, fc.id, $3, $4, $5, $6
     FROM fixed_contacts fc
     WHERE fc.id = $2 AND fc.user_id = $1
     RETURNING *`,
    [userId, contactId, input.kind, occurredAt, input.summary ?? null, input.mood ?? null],
  );
  if (!result.rows[0]) return null;

  await query(
    `UPDATE fixed_contacts SET last_contact_at = $1
     WHERE id = $2 AND user_id = $3
       AND (last_contact_at IS NULL OR last_contact_at < $1)`,
    [occurredAt, contactId, userId],
  );
  return result.rows[0] as InteractionRow;
}

/** 合并时间线（interactions + promises + gifts），按时间倒序分页 */
export async function listContactTimeline(
  userId: number,
  contactId: number,
  page: number,
  limit: number,
): Promise<{ items: TimelineEntry[]; total: number } | null> {
  if (!(await contactOwnedBy(userId, contactId))) return null;

  const countResult = await query(
    `SELECT (
       (SELECT COUNT(*) FROM interactions WHERE user_id = $1 AND contact_id = $2)
       + (SELECT COUNT(*) FROM contact_promises WHERE contact_id = $2)
       + (SELECT COUNT(*) FROM gift_records WHERE contact_id = $2)
     )::int AS count`,
    [userId, contactId],
  );

  const offset = (page - 1) * limit;
  const result = await query(
    `SELECT 'interaction' AS type, id, occurred_at AS at, kind AS interaction_kind, summary, mood,
            NULL::text AS promise_text, NULL::date AS due_at, NULL::timestamptz AS done_at,
            NULL::text AS gift_description, NULL::text AS direction, NULL::text AS occasion,
            NULL::bigint AS amount_cents, created_at
     FROM interactions
     WHERE user_id = $1 AND contact_id = $2
     UNION ALL
     SELECT 'promise', id, COALESCE(done_at, due_at::timestamptz, created_at), NULL, NULL, NULL,
            text, due_at, done_at, NULL, NULL, NULL, NULL, created_at
     FROM contact_promises
     WHERE contact_id = $2
     UNION ALL
     SELECT 'gift', id, COALESCE(occurred_at::timestamptz, created_at), NULL, NULL, NULL,
            NULL, NULL, NULL, description, direction, occasion, amount_cents, created_at
     FROM gift_records
     WHERE contact_id = $2
     ORDER BY at DESC, type ASC, id DESC
     LIMIT $3 OFFSET $4`,
    [userId, contactId, limit, offset],
  );

  return {
    items: result.rows as TimelineEntry[],
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

/** 记录一个约定；due_at 可为 null（无期限） */
export async function createContactPromise(
  userId: number,
  contactId: number,
  input: CreateContactPromiseInput,
): Promise<ContactPromiseRow | null> {
  const result = await query(
    `INSERT INTO contact_promises (contact_id, text, due_at)
     SELECT fc.id, $2, $3
     FROM fixed_contacts fc
     WHERE fc.id = $1 AND fc.user_id = $4
     RETURNING *`,
    [contactId, input.text, input.dueAt ?? null, userId],
  );
  return (result.rows[0] as ContactPromiseRow | undefined) ?? null;
}

/** 记录一次礼物往来；occurred_at 缺省为今天 */
export async function createGiftRecord(
  userId: number,
  contactId: number,
  input: CreateGiftRecordInput,
): Promise<GiftRecordRow | null> {
  const result = await query(
    `INSERT INTO gift_records (contact_id, description, direction, occasion, amount_cents, occurred_at)
     SELECT fc.id, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE)
     FROM fixed_contacts fc
     WHERE fc.id = $1 AND fc.user_id = $7
     RETURNING *`,
    [
      contactId,
      input.description,
      input.direction,
      input.occasion ?? null,
      input.amountCents ?? null,
      input.occurredAt ?? null,
      userId,
    ],
  );
  return (result.rows[0] as GiftRecordRow | undefined) ?? null;
}

/**
 * 到期联系人（GET /api/contacts/due）：
 * - cadence_enabled = TRUE 且 cadence_days 非 NULL；
 * - 有效最后联系时间 = MAX(interactions.occurred_at)，否则回落 last_contact_at；
 * - 从未联系（有效值为 NULL）视为「现在就到期」，UI 的到期列表能看到
 *   （checkbox 62 的提醒任务会自行跳过从未联系的人）；
 * - cadence_days = NULL 的一律排除（不会被当成每天都到期）。
 */
export async function listDueContacts(userId: number): Promise<DueContactRow[]> {
  const result = await query(
    `SELECT fc.id, fc.user_id, fc.name, fc.nickname, fc.email, fc.phone,
            fc.relationship, fc.gender,
            fc.cadence_days, COALESCE(fc.cadence_enabled, FALSE) AS cadence_enabled,
            fc.last_contact_at,
            latest.last_contact_at AS effective_last_contact_at,
            CASE WHEN COALESCE(latest.last_contact_at, fc.last_contact_at) IS NULL THEN NULL
                 ELSE COALESCE(latest.last_contact_at, fc.last_contact_at)
                      + make_interval(days => fc.cadence_days)
            END AS next_due_at
     FROM fixed_contacts fc
     LEFT JOIN (
       SELECT contact_id, MAX(occurred_at) AS last_contact_at
       FROM interactions
       WHERE user_id = $1
       GROUP BY contact_id
     ) latest ON latest.contact_id = fc.id
     WHERE fc.user_id = $1
       AND COALESCE(fc.cadence_enabled, FALSE) = TRUE
       AND fc.cadence_days IS NOT NULL
       AND (
         COALESCE(latest.last_contact_at, fc.last_contact_at) IS NULL
         OR COALESCE(latest.last_contact_at, fc.last_contact_at)
            + make_interval(days => fc.cadence_days) <= NOW()
       )
     ORDER BY COALESCE(latest.last_contact_at, fc.last_contact_at) ASC NULLS FIRST, fc.name ASC`,
    [userId],
  );
  return result.rows as DueContactRow[];
}
