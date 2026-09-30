import { query } from '../db/index.js';

/**
 * Checkbox 134: cross-entity tag system (migration v58).
 *
 * `tags` is the per-user vocabulary; `tag_links` joins a tag to one of the eight supported
 * entity kinds. Tags are ORTHOGONAL to the pre-existing per-entity fields (`events.type`,
 * the legacy `events.tags` JSONB): nothing here reads or writes those columns.
 *
 * The module owns three concerns:
 *  1. CRUD over the vocabulary (duplicate name = 409, name longer than the cap = 400).
 *  2. Link/unlink against an entity that MUST belong to the caller - an unknown or foreign
 *     entity id is a 404, so a link row can never point at someone else's row.
 *  3. The smart filter: `listTaggedEntities` (a filtered entity list, AND by default / OR on
 *     request) plus `buildTagFilterPredicate`, the composition seam that entity list services
 *     append to their OWN WHERE clause without replacing any existing filter.
 */

export const TAG_ENTITY_TYPES = [
  'event',
  'contact',
  'document',
  'expiry',
  'inventory',
  'maintenance',
  'habit',
  'goal',
] as const;
export type TagEntityType = (typeof TAG_ENTITY_TYPES)[number];

/** Tables backing each taggable entity kind. Fixed map - never interpolated user input. */
const TAG_ENTITY_TABLES: Record<TagEntityType, string> = {
  event: 'events',
  contact: 'fixed_contacts',
  document: 'documents',
  expiry: 'expiry_items',
  inventory: 'inventory_items',
  maintenance: 'maintenance_plans',
  habit: 'habits',
  goal: 'goals',
};

/** Plan QA scenario: a name over the cap is rejected with a clear message. */
export const TAG_NAME_MAX_LENGTH = 32;
/** Optional color; six-digit hex only so the UI can render it without sanitising. */
export const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const TAG_LINK_LIST_DEFAULT_LIMIT = 50;
export const TAG_LINK_LIST_MAX_LIMIT = 200;
export const TAG_FILTER_MODES = ['and', 'or'] as const;
export type TagFilterMode = (typeof TAG_FILTER_MODES)[number];

export class TagError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'TagError';
  }
}

export interface TagRecord {
  id: number;
  name: string;
  color: string | null;
  created_at: string;
  /** Number of entity links; present on list responses. */
  link_count?: number;
}

export interface TagLinkRecord {
  tag_id: number;
  entity_type: TagEntityType;
  entity_id: number;
  created_at: string;
}

export interface TaggedEntity {
  entity_type: TagEntityType;
  entity_id: number;
  /** Every requested tag id that this entity carries. */
  tag_ids: number[];
}

export interface TagFilterSelection {
  tagIds: number[];
  mode: TagFilterMode;
}

export interface TagFilterPredicate {
  sql: string;
  params: unknown[];
}

export function isTagEntityType(value: unknown): value is TagEntityType {
  return typeof value === 'string' && (TAG_ENTITY_TYPES as readonly string[]).includes(value);
}

export function isTagFilterMode(value: unknown): value is TagFilterMode {
  return value === 'and' || value === 'or';
}

/** Trim + collapse nothing else: names are compared byte-exact by `UNIQUE(user_id, name)`. */
export function normalizeTagName(raw: string): string {
  return raw.trim();
}

function invalidEntityType(value: string): TagError {
  return new TagError(
    `未知的实体类型: ${value}（可用: ${TAG_ENTITY_TYPES.join(', ')}）`,
    400,
    'invalid_entity_type',
  );
}

function validateName(raw: string): string {
  const name = normalizeTagName(raw);
  if (name.length === 0) {
    throw new TagError('标签名称不能为空', 400, 'tag_name_empty');
  }
  if (name.length > TAG_NAME_MAX_LENGTH) {
    throw new TagError(`标签名称最长 ${TAG_NAME_MAX_LENGTH} 个字符`, 400, 'tag_name_too_long');
  }
  return name;
}

function validateColor(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const color = raw.trim();
  if (color === '') return null;
  if (!TAG_COLOR_PATTERN.test(color)) {
    throw new TagError('标签颜色必须为 #RRGGBB 格式', 400, 'tag_color_invalid');
  }
  return color.toLowerCase();
}

function serializeTag(row: Record<string, unknown>): TagRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    color: row.color == null ? null : String(row.color),
    created_at: String(row.created_at),
    ...(row.link_count === undefined ? {} : { link_count: Number(row.link_count) }),
  };
}

/** All of the caller's tags, name-ordered, each with its link count (0 when unused). */
export async function listTags(userId: number): Promise<TagRecord[]> {
  const result = await query(
    `SELECT t.id, t.name, t.color, t.created_at, COUNT(tl.id)::int AS link_count
       FROM tags t
       LEFT JOIN tag_links tl ON tl.tag_id = t.id
      WHERE t.user_id = $1
      GROUP BY t.id
      ORDER BY t.name ASC, t.id ASC`,
    [userId],
  );
  return result.rows.map((row) => serializeTag(row as Record<string, unknown>));
}

async function getTagRow(userId: number, id: number): Promise<TagRecord | null> {
  const result = await query('SELECT id, name, color, created_at FROM tags WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? serializeTag(row as Record<string, unknown>) : null;
}

/** Creates one tag. A duplicate `(user_id, name)` surfaces as a 409, never a 500. */
export async function createTag(
  userId: number,
  input: { name: string; color?: string | null },
): Promise<TagRecord> {
  const name = validateName(input.name);
  const color = validateColor(input.color);

  const result = await query(
    `INSERT INTO tags (user_id, name, color)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO NOTHING
     RETURNING id, name, color, created_at`,
    [userId, name, color],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TagError(`标签名称已存在: ${name}`, 409, 'tag_name_taken');
  }
  return serializeTag(row as Record<string, unknown>);
}

/** Updates name and/or color. Unknown/foreign id = 404; a name clash = 409. */
export async function updateTag(
  userId: number,
  id: number,
  patch: { name?: string; color?: string | null },
): Promise<TagRecord> {
  if (patch.name === undefined && patch.color === undefined) {
    throw new TagError('没有需要更新的字段', 400, 'empty_update');
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (patch.name !== undefined) {
    const name = validateName(patch.name);
    const clash = await query('SELECT id FROM tags WHERE user_id = $1 AND name = $2 AND id <> $3', [
      userId,
      name,
      id,
    ]);
    if (clash.rows.length > 0) {
      throw new TagError(`标签名称已存在: ${name}`, 409, 'tag_name_taken');
    }
    sets.push(`name = $${paramIndex++}`);
    params.push(name);
  }
  if (patch.color !== undefined) {
    sets.push(`color = $${paramIndex++}`);
    params.push(validateColor(patch.color));
  }

  params.push(id, userId);
  const result = await query(
    `UPDATE tags SET ${sets.join(', ')}
      WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
      RETURNING id, name, color, created_at`,
    params,
  );
  const row = result.rows[0];
  if (!row) throw new TagError('标签不存在', 404, 'tag_not_found');
  return serializeTag(row as Record<string, unknown>);
}

/**
 * Deletes a tag and (via the `tag_links.tag_id` FK cascade in v58) every link to it.
 * Linked entities live in their own tables and are NEVER touched by this path.
 */
export async function deleteTag(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM tags WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return result.rows.length > 0;
}

/** True only when `(entityType, entityId)` names a row owned by `userId`. */
export async function entityExistsForUser(
  userId: number,
  entityType: TagEntityType,
  entityId: number,
): Promise<boolean> {
  if (!isTagEntityType(entityType)) throw invalidEntityType(String(entityType));
  const table = TAG_ENTITY_TABLES[entityType];
  const result = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [entityId, userId]);
  return result.rows.length > 0;
}

async function requireOwnedTag(userId: number, tagId: number): Promise<void> {
  const tag = await getTagRow(userId, tagId);
  if (!tag) throw new TagError('标签不存在', 404, 'tag_not_found');
}

/**
 * Links a tag to an entity. Idempotent: linking twice succeeds and reports
 * `created: false` instead of INSERTing a duplicate row (the v58 UNIQUE backs this).
 * A foreign/unknown entity is a 404 BEFORE any insert - the link table has no
 * polymorphic FK, so this check is what keeps it orphan-free.
 */
export async function linkTag(
  userId: number,
  tagId: number,
  entityType: string,
  entityId: number,
): Promise<{ link: TagLinkRecord; created: boolean }> {
  if (!isTagEntityType(entityType)) throw invalidEntityType(entityType);
  await requireOwnedTag(userId, tagId);
  if (!(await entityExistsForUser(userId, entityType, entityId))) {
    throw new TagError('实体不存在', 404, 'entity_not_found');
  }

  const inserted = await query(
    `INSERT INTO tag_links (tag_id, user_id, entity_type, entity_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tag_id, entity_type, entity_id) DO NOTHING
     RETURNING tag_id, entity_type, entity_id, created_at`,
    [tagId, userId, entityType, entityId],
  );

  const row = (inserted.rows[0] ??
    (await query(
      `SELECT tag_id, entity_type, entity_id, created_at FROM tag_links
        WHERE tag_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [tagId, entityType, entityId],
    )).rows[0]) as Record<string, unknown> | undefined;

  if (!row) throw new TagError('标签关联失败', 500, 'tag_link_failed');
  return {
    link: {
      tag_id: Number(row.tag_id),
      entity_type: row.entity_type as TagEntityType,
      entity_id: Number(row.entity_id),
      created_at: String(row.created_at),
    },
    created: inserted.rows.length > 0,
  };
}

/** Removes one link. Returns false when it did not exist (a retry is a no-op, not an error). */
export async function unlinkTag(
  userId: number,
  tagId: number,
  entityType: string,
  entityId: number,
): Promise<boolean> {
  if (!isTagEntityType(entityType)) throw invalidEntityType(entityType);
  const result = await query(
    `DELETE FROM tag_links
      WHERE tag_id = $1 AND user_id = $2 AND entity_type = $3 AND entity_id = $4
      RETURNING id`,
    [tagId, userId, entityType, entityId],
  );
  return result.rows.length > 0;
}

/** Tags currently attached to one entity (chips on a detail page). */
export async function listEntityTags(
  userId: number,
  entityType: string,
  entityId: number,
): Promise<TagRecord[]> {
  if (!isTagEntityType(entityType)) throw invalidEntityType(entityType);
  const result = await query(
    `SELECT t.id, t.name, t.color, t.created_at
       FROM tag_links tl
       JOIN tags t ON t.id = tl.tag_id
      WHERE tl.user_id = $1 AND tl.entity_type = $2 AND tl.entity_id = $3
      ORDER BY t.name ASC, t.id ASC`,
    [userId, entityType, entityId],
  );
  return result.rows.map((row) => serializeTag(row as Record<string, unknown>));
}

export interface ListTaggedEntitiesOptions {
  tagIds: number[];
  mode?: TagFilterMode;
  entityTypes?: TagEntityType[];
  limit?: number;
}

/**
 * The smart filter. Returns one row per `(entity_type, entity_id)` carrying every requested
 * tag id. `mode: 'and'` (the DEFAULT) requires ALL requested tags; `mode: 'or'` requires ANY.
 * The type filter and the limit COMPOSE with the tag predicate - they are additional
 * parameters, never a replacement.
 */
export async function listTaggedEntities(
  userId: number,
  options: ListTaggedEntitiesOptions,
): Promise<TaggedEntity[]> {
  const mode = options.mode ?? 'and';
  if (!isTagFilterMode(mode)) {
    throw new TagError(`过滤模式只能为 'and' 或 'or'`, 400, 'invalid_tag_mode');
  }
  const tagIds = [...new Set(options.tagIds)];
  if (tagIds.length === 0) return [];

  const entityTypes = options.entityTypes ?? [...TAG_ENTITY_TYPES];
  for (const entityType of entityTypes) {
    if (!isTagEntityType(entityType)) throw invalidEntityType(String(entityType));
  }

  const requestedLimit = options.limit ?? TAG_LINK_LIST_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(Math.trunc(requestedLimit) || TAG_LINK_LIST_DEFAULT_LIMIT, 1), TAG_LINK_LIST_MAX_LIMIT);

  const params: unknown[] = [userId, tagIds, entityTypes];
  let havingSql = '';
  if (mode === 'and') {
    params.push(tagIds.length);
    havingSql = `HAVING COUNT(DISTINCT tl.tag_id) = $${params.length}`;
  }
  params.push(limit);

  const result = await query(
    `SELECT tl.entity_type, tl.entity_id, ARRAY_AGG(DISTINCT tl.tag_id ORDER BY tl.tag_id)::int[] AS tag_ids
       FROM tag_links tl
      WHERE tl.user_id = $1 AND tl.tag_id = ANY($2::int[]) AND tl.entity_type = ANY($3::text[])
      GROUP BY tl.entity_type, tl.entity_id
      ${havingSql}
      ORDER BY tl.entity_type ASC, tl.entity_id ASC
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => {
    const typed = row as Record<string, unknown>;
    return {
      entity_type: typed.entity_type as TagEntityType,
      entity_id: Number(typed.entity_id),
      tag_ids: (typed.tag_ids as number[]).map(Number),
    };
  });
}

/**
 * Composition seam for the eight entity list services: append the returned predicate to the
 * service's OWN `WHERE` array (the caller keeps every existing filter and its numbering).
 * `outerId` is the table-qualified id column, e.g. `expiry_items.id` or `e.id`.
 *
 * `startParamIndex` is the number of parameters already bound (the next `$n` to hand out),
 * so the predicate composes instead of colliding. AND mode matches ALL requested tags
 * (`= count`), OR mode matches ANY (`EXISTS`). Unknown tag names simply match nothing, and
 * the predicate is scoped by `tl.user_id` - a foreign tag can never widen the result set.
 */
export function buildTagFilterPredicate(
  outerId: string,
  startParamIndex: number,
  userId: number,
  entityType: TagEntityType,
  tagNames: string[],
  mode: TagFilterMode = 'and',
): TagFilterPredicate | null {
  if (!isTagEntityType(entityType)) throw invalidEntityType(String(entityType));
  if (tagNames.length === 0) return null;
  const unique = [...new Set(tagNames.map(normalizeTagName).filter((name) => name.length > 0))];
  if (unique.length === 0) return null;
  if (!isTagFilterMode(mode)) throw new TagError(`过滤模式只能为 'and' 或 'or'`, 400, 'invalid_tag_mode');

  const n = startParamIndex;
  const params: unknown[] = [userId, entityType, unique];
  const subquery = `SELECT tl.tag_id FROM tag_links tl JOIN tags t ON t.id = tl.tag_id
        WHERE tl.user_id = $${n} AND tl.entity_type = $${n + 1} AND tl.entity_id = ${outerId}
          AND t.name = ANY($${n + 2}::text[])`;

  if (mode === 'or') {
    return { sql: `EXISTS (${subquery})`, params };
  }
  params.push(unique.length);
  return { sql: `(SELECT COUNT(DISTINCT tag_id) FROM (${subquery}) matched) = $${n + 3}`, params };
}
