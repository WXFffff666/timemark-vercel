import { query, withTransaction } from '../db/index.js';
import { logAudit } from './audit.service.js';
import { createLogger } from '../utils/logger.js';

/**
 * Task 137: data-health detection + one-click repairs.
 *
 * Every detector is user-scoped, read-only, and returns a count plus a bounded example
 * list. Every repair is idempotent (a second run repairs 0 further rows) and auditable:
 * the outcome is written through the shipped `services/audit.service.ts` (`logAudit`) and,
 * best-effort, into the `data_health_repairs` ledger (pending migration 65). A destructive
 * repair (one that deletes rows) refuses to run without an explicit `confirm`.
 */

const log = createLogger('data-health');

export const DATA_HEALTH_KINDS = [
  'orphan_tag_links',
  'events_no_profile',
  'contacts_no_cadence',
  'expired_not_archived',
  'duplicate_contacts',
  'unset_timezone',
] as const;

export type DataHealthKind = (typeof DATA_HEALTH_KINDS)[number];

export interface DataHealthRepairInfo {
  label: string;
  destructive: boolean;
  hint: string;
}

export interface DataHealthFinding {
  kind: DataHealthKind;
  title: string;
  description: string;
  severity: 'info' | 'warning';
  count: number;
  examples: Array<Record<string, unknown>>;
  repair: DataHealthRepairInfo;
}

export interface DataHealthReport {
  generatedAt: string;
  totalFindings: number;
  totalIssues: number;
  findings: DataHealthFinding[];
}

export interface DataHealthRepairResult {
  kind: DataHealthKind;
  repaired: number;
  destructive: boolean;
  confirmed: boolean;
  message: string;
}

export type DataHealthRepairOutcome =
  | { status: 'ok'; result: DataHealthRepairResult }
  | { status: 'confirmation_required'; destructive: boolean; hint: string };

const META: Record<DataHealthKind, {
  title: string;
  description: string;
  severity: 'info' | 'warning';
  repair: DataHealthRepairInfo;
}> = {
  orphan_tag_links: {
    title: '孤立标签关联',
    description: '标签关联指向了已删除的实体，永远不会再显示。',
    severity: 'warning',
    repair: { label: '清理孤立关联', destructive: true, hint: '删除这些指向不存在实体的标签关联行。' },
  },
  events_no_profile: {
    title: '事件未归属档案',
    description: '存在没有归属档案的事件（profile_id 为空）。',
    severity: 'info',
    repair: { label: '归入默认档案', destructive: false, hint: '把无档案事件归入你的默认档案。' },
  },
  contacts_no_cadence: {
    title: '联系人未设置联系节奏',
    description: '联系人缺少联系节奏（cadence），无法计算下次联系时间。',
    severity: 'info',
    repair: { label: '设置默认节奏（30 天）', destructive: false, hint: '为缺失节奏的联系人启用 30 天联系节奏。' },
  },
  expired_not_archived: {
    title: '已过期但未归档的到期项',
    description: '到期日已过但仍处于启用状态的订阅 / 账单等。',
    severity: 'warning',
    repair: { label: '归档已过期项', destructive: false, hint: '把过期项标记为已归档（数据保留，可恢复）。' },
  },
  duplicate_contacts: {
    title: '重复联系人',
    description: '同一用户名下存在同名联系人，可能产生重复记录。',
    severity: 'warning',
    repair: { label: '合并重复联系人', destructive: true, hint: '把互动 / 承诺 / 礼物记录迁移到最早创建的联系人后删除重复项。' },
  },
  unset_timezone: {
    title: '未设置时区',
    description: '用户配置或档案缺少时区，提醒时间会回退到默认时区。',
    severity: 'info',
    repair: { label: '设置为默认时区', destructive: false, hint: '为未设置时区的配置 / 档案填入默认时区（Asia/Shanghai）。' },
  },
};

/** SQL fragment: tag_links row is NOT orphaned when the referenced entity exists and is owned. */
const TAG_LINK_ENTITY_EXISTS = `(
     (tl.entity_type = 'event'       AND EXISTS (SELECT 1 FROM events t            WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'contact'     AND EXISTS (SELECT 1 FROM fixed_contacts t    WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'document'    AND EXISTS (SELECT 1 FROM documents t         WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'expiry'      AND EXISTS (SELECT 1 FROM expiry_items t      WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'inventory'   AND EXISTS (SELECT 1 FROM inventory_items t   WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'maintenance' AND EXISTS (SELECT 1 FROM maintenance_plans t WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'habit'       AND EXISTS (SELECT 1 FROM habits t            WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
  OR (tl.entity_type = 'goal'        AND EXISTS (SELECT 1 FROM goals t             WHERE t.id = tl.entity_id AND t.user_id = tl.user_id))
)`;

// Only contacts with NO cadence value are flagged: a cadence that exists but is
// intentionally switched off (`cadence_enabled = FALSE`) is left untouched.
const CONTACTS_NO_CADENCE_WHERE = `user_id = $1 AND (cadence_days IS NULL OR cadence_days <= 0)`;

async function scalarCount(sql: string, params: unknown[]): Promise<number> {
  const result = await query(sql, params);
  return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
}

interface DetectorResult {
  count: number;
  examples: Array<Record<string, unknown>>;
}

async function detectOrphanTagLinks(userId: number): Promise<DetectorResult> {
  const where = `tl.user_id = $1 AND NOT ${TAG_LINK_ENTITY_EXISTS}`;
  const count = await scalarCount(`SELECT count(*)::int AS count FROM tag_links tl WHERE ${where}`, [userId]);
  const rows = await query(
    `SELECT tl.id, tl.tag_id, tl.entity_type, tl.entity_id FROM tag_links tl WHERE ${where} ORDER BY tl.id LIMIT 8`,
    [userId],
  );
  return { count, examples: rows.rows };
}

async function detectEventsNoProfile(userId: number): Promise<DetectorResult> {
  const count = await scalarCount(
    'SELECT count(*)::int AS count FROM events WHERE user_id = $1 AND profile_id IS NULL',
    [userId],
  );
  const rows = await query(
    'SELECT id, name, date FROM events WHERE user_id = $1 AND profile_id IS NULL ORDER BY date DESC LIMIT 8',
    [userId],
  );
  return { count, examples: rows.rows };
}

async function detectContactsNoCadence(userId: number): Promise<DetectorResult> {
  const count = await scalarCount(
    `SELECT count(*)::int AS count FROM fixed_contacts WHERE ${CONTACTS_NO_CADENCE_WHERE}`,
    [userId],
  );
  const rows = await query(
    `SELECT id, name, email, cadence_days, cadence_enabled FROM fixed_contacts WHERE ${CONTACTS_NO_CADENCE_WHERE} ORDER BY id LIMIT 8`,
    [userId],
  );
  return { count, examples: rows.rows };
}

async function detectExpiredNotArchived(userId: number): Promise<DetectorResult> {
  const where = 'user_id = $1 AND is_active = TRUE AND next_due_date < CURRENT_DATE';
  const count = await scalarCount(`SELECT count(*)::int AS count FROM expiry_items WHERE ${where}`, [userId]);
  const rows = await query(
    `SELECT id, title, kind, next_due_date FROM expiry_items WHERE ${where} ORDER BY next_due_date LIMIT 8`,
    [userId],
  );
  return { count, examples: rows.rows };
}

const DUPLICATE_CONTACTS_GROUPS = `SELECT lower(btrim(name)) AS name, count(*)::int AS occurrences, array_agg(id ORDER BY id) AS ids
   FROM fixed_contacts WHERE user_id = $1 GROUP BY 1 HAVING count(*) > 1 ORDER BY occurrences DESC LIMIT 8`;

async function detectDuplicateContacts(userId: number): Promise<DetectorResult> {
  const count = await scalarCount(
    'SELECT count(*)::int AS count FROM (SELECT lower(btrim(name)) FROM fixed_contacts WHERE user_id = $1 GROUP BY 1 HAVING count(*) > 1) d',
    [userId],
  );
  const rows = await query(DUPLICATE_CONTACTS_GROUPS, [userId]);
  return { count, examples: rows.rows };
}

async function detectUnsetTimezone(userId: number): Promise<DetectorResult> {
  const cfgCount = await scalarCount(
    `SELECT count(*)::int AS count FROM user_configs WHERE user_id = $1 AND (timezone IS NULL OR btrim(timezone) = '')`,
    [userId],
  );
  const profileCount = await scalarCount(
    `SELECT count(*)::int AS count FROM profiles WHERE user_id = $1 AND (timezone IS NULL OR btrim(timezone) = '')`,
    [userId],
  );
  const rows = await query(
    `SELECT 'user_config' AS source, user_id AS id, NULL::text AS name FROM user_configs
       WHERE user_id = $1 AND (timezone IS NULL OR btrim(timezone) = '')
     UNION ALL
     SELECT 'profile' AS source, id, name FROM profiles
       WHERE user_id = $1 AND (timezone IS NULL OR btrim(timezone) = '')
     ORDER BY source LIMIT 8`,
    [userId],
  );
  return { count: cfgCount + profileCount, examples: rows.rows };
}

const DETECTORS: ReadonlyArray<{ kind: DataHealthKind; run: (userId: number) => Promise<DetectorResult> }> = [
  { kind: 'orphan_tag_links', run: detectOrphanTagLinks },
  { kind: 'events_no_profile', run: detectEventsNoProfile },
  { kind: 'contacts_no_cadence', run: detectContactsNoCadence },
  { kind: 'expired_not_archived', run: detectExpiredNotArchived },
  { kind: 'duplicate_contacts', run: detectDuplicateContacts },
  { kind: 'unset_timezone', run: detectUnsetTimezone },
];

export async function getDataHealthReport(userId: number): Promise<DataHealthReport> {
  const findings: DataHealthFinding[] = [];
  for (const detector of DETECTORS) {
    let count = 0;
    let examples: Array<Record<string, unknown>> = [];
    try {
      const result = await detector.run(userId);
      count = result.count;
      examples = result.examples;
    } catch (error) {
      log.warn(
        { event: 'data_health.detector_failed', kind: detector.kind, err: error instanceof Error ? error.message : String(error) },
        'data health detector failed',
      );
    }
    const meta = META[detector.kind];
    findings.push({
      kind: detector.kind,
      title: meta.title,
      description: meta.description,
      severity: meta.severity,
      count,
      examples,
      repair: meta.repair,
    });
  }
  const totalIssues = findings.reduce((sum, finding) => sum + finding.count, 0);
  return {
    generatedAt: new Date().toISOString(),
    totalFindings: findings.filter((finding) => finding.count > 0).length,
    totalIssues,
    findings,
  };
}

/** Best-effort audit: never blocks or fails the repair outcome. */
async function recordRepair(userId: number, result: DataHealthRepairResult, confirmed: boolean): Promise<void> {
  await logAudit(userId, 'data_health.repair', result.kind, undefined, {
    repaired: result.repaired,
    destructive: result.destructive,
    confirmed,
  });
  try {
    await query(
      `INSERT INTO data_health_repairs (user_id, kind, repaired_count, confirmed, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, result.kind, result.repaired, confirmed, JSON.stringify({ destructive: result.destructive })],
    );
  } catch (error) {
    log.warn(
      { event: 'data_health.ledger_write_failed', err: error instanceof Error ? error.message : String(error) },
      'Failed to write data health repair ledger entry',
    );
  }
}

async function repairOrphanTagLinks(userId: number): Promise<number> {
  const result = await query(
    `DELETE FROM tag_links tl WHERE tl.user_id = $1 AND NOT ${TAG_LINK_ENTITY_EXISTS}`,
    [userId],
  );
  return result.rowCount;
}

async function repairEventsNoProfile(userId: number): Promise<number> {
  const result = await query(
    `UPDATE events SET profile_id = (
       SELECT id FROM profiles WHERE user_id = $1 AND is_active = TRUE
       ORDER BY (kind = 'self') DESC, sort_order ASC, id ASC LIMIT 1
     )
     WHERE user_id = $1 AND profile_id IS NULL
       AND EXISTS (SELECT 1 FROM profiles WHERE user_id = $1 AND is_active = TRUE)`,
    [userId],
  );
  return result.rowCount;
}

async function repairContactsNoCadence(userId: number): Promise<number> {
  const result = await query(
    `UPDATE fixed_contacts
     SET cadence_days = CASE WHEN cadence_days IS NULL OR cadence_days <= 0 THEN 30 ELSE cadence_days END,
         cadence_enabled = TRUE,
         updated_at = CURRENT_TIMESTAMP
     WHERE ${CONTACTS_NO_CADENCE_WHERE}`,
    [userId],
  );
  return result.rowCount;
}

async function repairExpiredNotArchived(userId: number): Promise<number> {
  const result = await query(
    `UPDATE expiry_items SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND is_active = TRUE AND next_due_date < CURRENT_DATE`,
    [userId],
  );
  return result.rowCount;
}

/**
 * Merge each duplicate-name group into its earliest-created contact: reassign interactions,
 * promises and gifts to the keeper, drop the duplicates' tag links (so no orphan is created)
 * and delete the duplicate rows. Runs inside one transaction so a failure leaves nothing
 * half-merged.
 */
async function repairDuplicateContacts(userId: number): Promise<number> {
  const groups = await query(DUPLICATE_CONTACTS_GROUPS, [userId]);
  if (groups.rows.length === 0) return 0;
  return withTransaction(async (client) => {
    let repaired = 0;
    for (const group of groups.rows as Array<{ ids?: unknown }>) {
      const ids = Array.isArray(group.ids) ? group.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id)).sort((a, b) => a - b) : [];
      if (ids.length < 2) continue;
      const keeper = ids[0];
      for (const duplicate of ids.slice(1)) {
        await client.query('UPDATE interactions SET contact_id = $1 WHERE contact_id = $2 AND user_id = $3', [keeper, duplicate, userId]);
        await client.query('UPDATE contact_promises SET contact_id = $1 WHERE contact_id = $2', [keeper, duplicate]);
        await client.query('UPDATE gift_records SET contact_id = $1 WHERE contact_id = $2', [keeper, duplicate]);
        await client.query("DELETE FROM tag_links WHERE user_id = $1 AND entity_type = 'contact' AND entity_id = $2", [userId, duplicate]);
        await client.query('DELETE FROM fixed_contacts WHERE id = $1 AND user_id = $2', [duplicate, userId]);
        repaired += 1;
      }
    }
    return repaired;
  });
}

async function repairUnsetTimezone(userId: number): Promise<number> {
  return withTransaction(async (client) => {
    const cfg = await client.query(
      `UPDATE user_configs SET timezone = 'Asia/Shanghai'
       WHERE user_id = $1 AND (timezone IS NULL OR btrim(timezone) = '')`,
      [userId],
    );
    const profiles = await client.query(
      `UPDATE profiles
       SET timezone = COALESCE((SELECT NULLIF(btrim(timezone), '') FROM user_configs WHERE user_id = $1), 'Asia/Shanghai'),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND (timezone IS NULL OR btrim(timezone) = '')`,
      [userId],
    );
    return (cfg.rowCount ?? 0) + (profiles.rowCount ?? 0);
  });
}

const REPAIRS: Record<DataHealthKind, (userId: number) => Promise<number>> = {
  orphan_tag_links: repairOrphanTagLinks,
  events_no_profile: repairEventsNoProfile,
  contacts_no_cadence: repairContactsNoCadence,
  expired_not_archived: repairExpiredNotArchived,
  duplicate_contacts: repairDuplicateContacts,
  unset_timezone: repairUnsetTimezone,
};

export async function repairDataHealth(
  userId: number,
  kind: DataHealthKind,
  options: { confirm?: boolean } = {},
): Promise<DataHealthRepairOutcome> {
  const meta = META[kind];
  if (!meta || typeof REPAIRS[kind] !== 'function') {
    throw new Error(`Unknown data health kind: ${kind}`);
  }
  const destructive = meta.repair.destructive;
  const confirmed = options.confirm === true;
  if (destructive && !confirmed) {
    return { status: 'confirmation_required', destructive: true, hint: meta.repair.hint };
  }

  const repaired = await REPAIRS[kind](userId);
  const result: DataHealthRepairResult = {
    kind,
    repaired,
    destructive,
    confirmed,
    message: repaired > 0 ? `已修复 ${repaired} 处问题` : '未发现需要修复的问题',
  };
  await recordRepair(userId, result, confirmed);
  return { status: 'ok', result };
}
