import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  TAG_ENTITY_TYPES,
  TAG_FILTER_MODES,
  TAG_NAME_MAX_LENGTH,
  TAG_COLOR_PATTERN,
  TagError,
  createTag,
  deleteTag,
  isTagEntityType,
  isTagFilterMode,
  linkTag,
  listTaggedEntities,
  listTags,
  unlinkTag,
  updateTag,
  type TagEntityType,
  type TagFilterMode,
} from '../services/tag.service.js';

/**
 * Checkbox 134: cross-entity tag API.
 *
 *   GET    /api/tags              vocabulary + link counts
 *   POST   /api/tags              create (duplicate name -> 409)
 *   PATCH  /api/tags/:id          rename / recolor (foreign or unknown -> 404)
 *   DELETE /api/tags/:id          delete the tag AND its links, never the entities
 *   POST   /api/tags/:id/links    attach (idempotent; foreign entity -> 404)
 *   DELETE /api/tags/:id/links    detach (idempotent)
 *   GET    /api/tags/entities     smart filter: AND (default) / OR over entity types + limit
 *
 * Convention matches the other routes: `new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`, `{ success, data }` envelopes, zod `.strict()` bodies.
 * Every query is user-scoped; "not found" and "someone else's row" are both 404.
 */
const tags = new Hono<{ Variables: { user: User } }>();
tags.use('*', authMiddleware);

const createTagSchema = z
  .object({
    name: z.string().trim().min(1).max(TAG_NAME_MAX_LENGTH),
    color: z.string().regex(TAG_COLOR_PATTERN).nullish(),
  })
  .strict();

const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(TAG_NAME_MAX_LENGTH).optional(),
    color: z.string().regex(TAG_COLOR_PATTERN).nullish(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: '至少提供 name 或 color 之一',
  });

const linkSchema = z
  .object({
    entityType: z.enum(TAG_ENTITY_TYPES),
    entityId: z.number().int().positive(),
  })
  .strict();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** TagError -> its declared status; anything else is a real bug and stays a 500. */
function handleTagError(c: Context, error: unknown): Response {
  if (error instanceof TagError) {
    return c.json({ success: false, error: error.message, code: error.code }, error.status as ContentfulStatusCode);
  }
  throw error;
}

function zodError(c: Context, error: z.ZodError): Response {
  return c.json({ success: false, error: formatZodError(error), details: z.flattenError(error) }, 400);
}

/** `?tagIds=1,2` and `?tagIds=1&tagIds=2` are both accepted; anything else is a 400. */
function parseIdList(c: Context, name: string): number[] | null {
  const raw = c.req.queries(name) ?? [];
  const parts = raw.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const ids: number[] = [];
  for (const part of parts) {
    const id = parseId(part);
    if (id === null) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

function parseEntityTypes(raw: string | undefined): TagEntityType[] | string {
  if (raw === undefined || raw.trim() === '') return [...TAG_ENTITY_TYPES];
  const parts = raw.split(',').map((value) => value.trim()).filter(Boolean);
  for (const part of parts) {
    if (!isTagEntityType(part)) return part; // the offending value, for a clear 400
  }
  return [...new Set(parts)] as TagEntityType[];
}

tags.get('/entities', async (c) => {
  const userId = Number(c.get('user').id);

  const tagIds = parseIdList(c, 'tagIds');
  if (tagIds === null) {
    return c.json({ success: false, error: 'tagIds 必须为逗号分隔的正整数', code: 'invalid_tag_ids' }, 400);
  }

  const entityTypes = parseEntityTypes(c.req.query('entityTypes'));
  if (typeof entityTypes === 'string') {
    return c.json(
      { success: false, error: `未知的实体类型: ${entityTypes}`, code: 'invalid_entity_type' },
      400,
    );
  }

  const modeRaw = c.req.query('mode') ?? 'and';
  if (!isTagFilterMode(modeRaw)) {
    return c.json(
      { success: false, error: `过滤模式只能为 ${TAG_FILTER_MODES.join(' / ')}`, code: 'invalid_tag_mode' },
      400,
    );
  }
  const mode: TagFilterMode = modeRaw;

  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  try {
    const entities = await listTaggedEntities(userId, {
      tagIds,
      mode,
      entityTypes,
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
    });
    return c.json({
      success: true,
      data: entities,
      mode,
      entityTypes,
      total: entities.length,
    });
  } catch (error) {
    return handleTagError(c, error);
  }
});

tags.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const data = await listTags(userId);
  return c.json({ success: true, data });
});

tags.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createTagSchema.safeParse(body);
  if (!parsed.success) return zodError(c, parsed.error);

  try {
    const tag = await createTag(userId, parsed.data);
    return c.json({ success: true, data: tag }, 201);
  } catch (error) {
    return handleTagError(c, error);
  }
});

tags.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateTagSchema.safeParse(body);
  if (!parsed.success) return zodError(c, parsed.error);

  try {
    const tag = await updateTag(userId, id, parsed.data);
    return c.json({ success: true, data: tag });
  } catch (error) {
    return handleTagError(c, error);
  }
});

tags.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteTag(userId, id);
  // 404 (not 403): a foreign tag and a missing tag are indistinguishable - no existence leak.
  if (!deleted) return c.json({ success: false, error: '标签不存在' }, 404);
  return c.json({ success: true });
});

tags.post('/:id/links', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) return zodError(c, parsed.error);

  try {
    const { link, created } = await linkTag(userId, id, parsed.data.entityType, parsed.data.entityId);
    // 200 on a repeat link (idempotent), 201 the first time.
    return c.json({ success: true, data: link, created }, created ? 201 : 200);
  } catch (error) {
    return handleTagError(c, error);
  }
});

tags.delete('/:id/links', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) return zodError(c, parsed.error);

  try {
    const removed = await unlinkTag(userId, id, parsed.data.entityType, parsed.data.entityId);
    return c.json({ success: true, removed });
  } catch (error) {
    return handleTagError(c, error);
  }
});

export default tags;
