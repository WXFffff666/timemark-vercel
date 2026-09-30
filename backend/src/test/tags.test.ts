import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Checkbox 134 acceptance: cross-entity tag system (migration v58).
 *
 * The DB is a small stateful fake that mirrors the exact semantics the shipped SQL relies on:
 * `ON CONFLICT DO NOTHING` (duplicate tag name + duplicate link), the `tag_links.tag_id` FK
 * cascade on tag delete, per-user scoping on every statement, and the AND (`HAVING COUNT =
 * n`) / OR grouping of the smart filter. The REAL service + route code runs end-to-end.
 *
 * Acceptance criteria covered:
 *   (a) CRUD + attach/detach tests
 *   (b) a cross-user isolation test
 *   (c) a list endpoint with two tags does an AND by default and OR when requested
 *   (d) deleting a tag removes its links but not the entities
 * Plan QA scenarios: attaching twice is idempotent (no duplicate row); a name over the cap is
 * rejected with a clear message.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(
        c,
        next,
      );
    },
  };
});

import tagsRoutes from '../routes/tags.js';
import {
  TAG_ENTITY_TYPES,
  TAG_NAME_MAX_LENGTH,
  buildTagFilterPredicate,
  listEntityTags,
  TagError,
} from '../services/tag.service.js';

const app = new Hono();
app.route('/api/tags', tagsRoutes);

interface TagRow {
  id: number;
  user_id: number;
  name: string;
  color: string | null;
  created_at: string;
}
interface LinkRow {
  id: number;
  tag_id: number;
  user_id: number;
  entity_type: string;
  entity_id: number;
  created_at: string;
}
/** One row of the `GET /entities` smart-filter result. */
interface TaggedEntityRow {
  entity_type: string;
  entity_id: number;
  tag_ids: number[];
}
/**
 * The tag API's `{ success, data }` envelope. `data` is a single row on create/update,
 * a tag list on `GET /`, and a tagged-entity list on `GET /entities`.
 */
interface TagApiBody {
  success: boolean;
  data: TagRow | TagRow[] | TaggedEntityRow[];
  error: string;
  code: string;
  created: boolean;
  removed: boolean;
  mode: string;
  total: number;
  entityTypes: string[];
}
/** `request` parses every body as `TagApiBody`, so narrow the DOM `json()` to match. */
interface TagTestResponse extends Response {
  json(): Promise<TagApiBody>;
}

let tags: TagRow[] = [];
let links: LinkRow[] = [];
let entities: Record<string, Array<{ id: number; user_id: number }>> = {};
let nextTagId = 1;
let nextLinkId = 1;

function resetState(): void {
  tags = [];
  links = [];
  entities = {
    events: [
      { id: 1, user_id: 1 },
      { id: 2, user_id: 1 },
      { id: 3, user_id: 2 },
    ],
    fixed_contacts: [{ id: 10, user_id: 1 }],
    documents: [{ id: 20, user_id: 1 }],
    expiry_items: [{ id: 30, user_id: 1 }],
    inventory_items: [{ id: 40, user_id: 1 }],
    maintenance_plans: [{ id: 50, user_id: 1 }],
    habits: [{ id: 60, user_id: 1 }],
    goals: [
      { id: 70, user_id: 1 },
      { id: 71, user_id: 2 },
    ],
  };
  nextTagId = 1;
  nextLinkId = 1;
}

function nowIso(): string {
  return new Date().toISOString();
}

function installDb(): void {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql);

    // --- smart filter: AND uses HAVING COUNT(DISTINCT ...) = $n; OR omits it ---------------
    if (s.includes('ARRAY_AGG(DISTINCT tl.tag_id')) {
      const userId = Number(params[0]);
      const tagIds = params[1] as number[];
      const entityTypes = params[2] as string[];
      const having = s.includes('HAVING COUNT(DISTINCT tl.tag_id)');
      const limit = Number(params[params.length - 1]);
      const required = having ? Number(params[params.length - 2]) : null;

      const groups = new Map<string, { entity_type: string; entity_id: number; tag_ids: number[] }>();
      for (const link of links) {
        if (link.user_id !== userId || !tagIds.includes(link.tag_id) || !entityTypes.includes(link.entity_type)) {
          continue;
        }
        const key = `${link.entity_type}:${link.entity_id}`;
        const group = groups.get(key) ?? { entity_type: link.entity_type, entity_id: link.entity_id, tag_ids: [] };
        if (!group.tag_ids.includes(link.tag_id)) group.tag_ids.push(link.tag_id);
        groups.set(key, group);
      }
      const rows = [...groups.values()]
        .filter((group) => required === null || new Set(group.tag_ids).size === required)
        .map((group) => ({ ...group, tag_ids: [...group.tag_ids].sort((a, b) => a - b) }))
        .sort((a, b) => a.entity_type.localeCompare(b.entity_type) || a.entity_id - b.entity_id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // --- tags (vocabulary) ----------------------------------------------------------------
    if (s.includes('COUNT(tl.id)::int AS link_count')) {
      const userId = Number(params[0]);
      const rows = tags
        .filter((tag) => tag.user_id === userId)
        .map((tag) => ({ ...tag, link_count: links.filter((link) => link.tag_id === tag.id).length }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
      return { rows, rowCount: rows.length };
    }
    if (s.includes('SELECT id, name, color, created_at FROM tags')) {
      const [id, userId] = params as [number, number];
      const row = tags.find((tag) => tag.id === id && tag.user_id === userId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM tags WHERE user_id = $1 AND name = $2')) {
      const [userId, name, id] = params as [number, string, number];
      const rows = tags.filter((tag) => tag.user_id === userId && tag.name === name && tag.id !== id);
      return { rows: rows.map((tag) => ({ id: tag.id })), rowCount: rows.length };
    }
    if (s.includes('INSERT INTO tags')) {
      const [userId, name, color] = params as [number, string, string | null];
      // ON CONFLICT (user_id, name) DO NOTHING
      if (tags.some((tag) => tag.user_id === userId && tag.name === name)) {
        return { rows: [], rowCount: 0 };
      }
      const row: TagRow = { id: nextTagId++, user_id: userId, name, color, created_at: nowIso() };
      tags.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes('UPDATE tags SET')) {
      const assignSegment = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE'));
      const columns = [...assignSegment.matchAll(/(\w+) = \$\d+/g)].map((match) => match[1]);
      const values = params.slice(0, columns.length);
      const [id, userId] = [Number(params[columns.length]), Number(params[columns.length + 1])];
      const row = tags.find((tag) => tag.id === id && tag.user_id === userId);
      if (!row) return { rows: [], rowCount: 0 };
      columns.forEach((column, index) => {
        if (column === 'name') row.name = String(values[index]);
        if (column === 'color') row.color = values[index] == null ? null : String(values[index]);
      });
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes('DELETE FROM tags WHERE')) {
      const [id, userId] = params as [number, number];
      const row = tags.find((tag) => tag.id === id && tag.user_id === userId);
      if (!row) return { rows: [], rowCount: 0 };
      tags = tags.filter((tag) => tag.id !== row.id);
      // FK: tag_links.tag_id REFERENCES tags(id) ON DELETE CASCADE
      links = links.filter((link) => link.tag_id !== row.id);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    // --- links ----------------------------------------------------------------------------
    if (s.includes('INSERT INTO tag_links')) {
      const [tagId, userId, entityType, entityId] = params as [number, number, string, number];
      const duplicate = links.some(
        (link) => link.tag_id === tagId && link.entity_type === entityType && link.entity_id === entityId,
      );
      if (duplicate) return { rows: [], rowCount: 0 };
      const row: LinkRow = {
        id: nextLinkId++,
        tag_id: tagId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        created_at: nowIso(),
      };
      links.push(row);
      return {
        rows: [{ tag_id: row.tag_id, entity_type: row.entity_type, entity_id: row.entity_id, created_at: row.created_at }],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT tag_id, entity_type, entity_id, created_at FROM tag_links')) {
      const [tagId, entityType, entityId] = params as [number, string, number];
      const row = links.find(
        (link) => link.tag_id === tagId && link.entity_type === entityType && link.entity_id === entityId,
      );
      return {
        rows: row
          ? [{ tag_id: row.tag_id, entity_type: row.entity_type, entity_id: row.entity_id, created_at: row.created_at }]
          : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (s.includes('DELETE FROM tag_links')) {
      const [tagId, userId, entityType, entityId] = params as [number, number, string, number];
      const row = links.find(
        (link) =>
          link.tag_id === tagId &&
          link.user_id === userId &&
          link.entity_type === entityType &&
          link.entity_id === entityId,
      );
      if (!row) return { rows: [], rowCount: 0 };
      links = links.filter((link) => link.id !== row.id);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (s.includes('JOIN tags t ON t.id = tl.tag_id')) {
      const [userId, entityType, entityId] = params as [number, string, number];
      const rows = links
        .filter(
          (link) => link.user_id === userId && link.entity_type === entityType && link.entity_id === entityId,
        )
        .map((link) => tags.find((tag) => tag.id === link.tag_id))
        .filter((tag): tag is TagRow => tag !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
      return { rows, rowCount: rows.length };
    }

    // --- entity ownership check -----------------------------------------------------------
    const entityMatch = /SELECT 1 FROM (\w+) WHERE id = \$1 AND user_id = \$2/.exec(s);
    if (entityMatch) {
      const [entityId, userId] = params as [number, number];
      const row = (entities[entityMatch[1]] ?? []).find(
        (entity) => entity.id === entityId && entity.user_id === userId,
      );
      return { rows: row ? [{ '?column?': 1 }] : [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`unhandled SQL in fake: ${s.slice(0, 80)}`);
  });
}

async function request(method: string, path: string, body?: unknown): Promise<TagTestResponse> {
  const normalized = path === '' || path.startsWith('/') ? path : `/${path}`;
  const response = await app.request(`/api/tags${normalized}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  return response as TagTestResponse;
}

async function createTagViaApi(name: string, color?: string): Promise<TagRow> {
  const response = await request('POST', '', color === undefined ? { name } : { name, color });
  expect(response.status).toBe(201);
  return (await response.json()).data as TagRow;
}

beforeEach(() => {
  authState.user = { id: 1, username: 'admin' };
  resetState();
  installDb();
});

describe('tag CRUD + attach/detach (acceptance a)', () => {
  it('starts empty, creates a trimmed tag (201), and lists it with link_count 0', async () => {
    const empty = await request('GET', '');
    expect(empty.status).toBe(200);
    expect((await empty.json()).data).toEqual([]);

    const created = await createTagViaApi('  工作  ');
    expect(created.name).toBe('工作');

    const list = await request('GET', '');
    const body = await list.json();
    expect(body.data).toHaveLength(1);
    expect((body.data as TagRow[])[0]).toMatchObject({ id: created.id, name: '工作', color: null, link_count: 0 });
  });

  it('QA failure: a duplicate name is a 409, not a 500', async () => {
    await createTagViaApi('工作');
    const response = await request('POST', '', { name: '工作' });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('tag_name_taken');
    expect(body.error).toContain('工作');
  });

  it(`QA failure: a name over ${TAG_NAME_MAX_LENGTH} chars is a 400 with a clear message`, async () => {
    const response = await request('POST', '', { name: 'x'.repeat(TAG_NAME_MAX_LENGTH + 1) });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(String(TAG_NAME_MAX_LENGTH));
    expect(tags).toHaveLength(0);
  });

  it('PATCH renames, lowercases the color, rejects an empty patch, and 409s on a rename clash', async () => {
    const first = await createTagViaApi('工作');
    const second = await createTagViaApi('生活');

    const renamed = await request('PATCH', `/${first.id}`, { name: '兼职', color: '#AABBCC' });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).data).toMatchObject({ name: '兼职', color: '#aabbcc' });

    const empty = await request('PATCH', `/${first.id}`, {});
    expect(empty.status).toBe(400);

    const clash = await request('PATCH', `/${first.id}`, { name: '生活' });
    expect(clash.status).toBe(409);
    expect((await clash.json()).code).toBe('tag_name_taken');
    expect(tags.find((tag) => tag.id === second.id)?.name).toBe('生活');
  });

  it('DELETE removes the tag; a second delete is a 404 (10 a foreign delete too)', async () => {
    const tag = await createTagViaApi('工作');
    const deleted = await request('DELETE', `/${tag.id}`);
    expect(deleted.status).toBe(200);

    const again = await request('DELETE', `/${tag.id}`);
    expect(again.status).toBe(404);

    const foreign = await createTagViaApi('生活');
    authState.user = { id: 2, username: 'other' };
    const denied = await request('DELETE', `/${foreign.id}`);
    expect(denied.status).toBe(404);
  });

  it('attaches idempotently (201 then 200, exactly ONE link row) and detaches idempotently', async () => {
    const tag = await createTagViaApi('工作');

    const first = await request('POST', `/${tag.id}/links`, { entityType: 'event', entityId: 1 });
    expect(first.status).toBe(201);
    expect((await first.json()).created).toBe(true);

    // QA scenario: attaching the same tag twice is idempotent (no duplicate row).
    const second = await request('POST', `/${tag.id}/links`, { entityType: 'event', entityId: 1 });
    expect(second.status).toBe(200);
    expect((await second.json()).created).toBe(false);
    expect(links).toHaveLength(1);

    const filtered = await request('GET', `entities?tagIds=${tag.id}`);
    const filteredBody = await filtered.json();
    expect(filteredBody.data).toEqual([{ entity_type: 'event', entity_id: 1, tag_ids: [tag.id] }]);

    const detached = await request('DELETE', `/${tag.id}/links`, { entityType: 'event', entityId: 1 });
    expect(detached.status).toBe(200);
    expect((await detached.json()).removed).toBe(true);

    const again = await request('DELETE', `/${tag.id}/links`, { entityType: 'event', entityId: 1 });
    expect(again.status).toBe(200);
    expect((await again.json()).removed).toBe(false);
    expect(links).toHaveLength(0);
  });

  it('rejects an unknown entity type (400), a non-existent entity (404) and a foreign entity (404)', async () => {
    const tag = await createTagViaApi('工作');

    const unknown = await request('POST', `/${tag.id}/links`, { entityType: 'spaceship', entityId: 1 });
    expect(unknown.status).toBe(400);

    const missing = await request('POST', `/${tag.id}/links`, { entityType: 'event', entityId: 999 });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('entity_not_found');

    // event 3 belongs to user 2 - attaching it as user 1 must not create a link.
    const foreign = await request('POST', `/${tag.id}/links`, { entityType: 'event', entityId: 3 });
    expect(foreign.status).toBe(404);
    expect(links).toHaveLength(0);
  });

  it('accepts all eight entity kinds', async () => {
    const tag = await createTagViaApi('全种类');
    const entityIds: Record<string, number> = {
      event: 1,
      contact: 10,
      document: 20,
      expiry: 30,
      inventory: 40,
      maintenance: 50,
      habit: 60,
      goal: 70,
    };
    for (const entityType of TAG_ENTITY_TYPES) {
      const response = await request('POST', `/${tag.id}/links`, { entityType, entityId: entityIds[entityType] });
      expect(response.status, `${entityType} link`).toBe(201);
    }
    expect(links).toHaveLength(8);
  });

  it('acceptance d: deleting a tag removes its links but NOT the entities', async () => {
    const tag = await createTagViaApi('临时');
    await request('POST', `/${tag.id}/links`, { entityType: 'event', entityId: 1 });
    await request('POST', `/${tag.id}/links`, { entityType: 'goal', entityId: 70 });
    expect(links).toHaveLength(2);

    const deleted = await request('DELETE', `/${tag.id}`);
    expect(deleted.status).toBe(200);
    expect(links).toHaveLength(0); // links gone (FK cascade)

    // The entities survived: the fixture rows are still there AND a fresh link still works.
    expect(entities.events.some((entity) => entity.id === 1 && entity.user_id === 1)).toBe(true);
    expect(entities.goals.some((entity) => entity.id === 70 && entity.user_id === 1)).toBe(true);
    const other = await createTagViaApi('新');
    const relink = await request('POST', `/${other.id}/links`, { entityType: 'event', entityId: 1 });
    expect(relink.status).toBe(201);
  });
});

describe('cross-user isolation (acceptance b)', () => {
  it("user A's vocabulary, links and entities are invisible to user B", async () => {
    const tagA = await createTagViaApi('私密');
    await request('POST', `/${tagA.id}/links`, { entityType: 'event', entityId: 1 });

    authState.user = { id: 2, username: 'other' };

    // Vocabulary: only B's own tags.
    const list = await request('GET', '');
    expect((await list.json()).data).toEqual([]);

    // Mutations on A's tag: indistinguishable from "does not exist".
    expect((await request('PATCH', `/${tagA.id}`, { name: '改名' })).status).toBe(404);
    expect((await request('DELETE', `/${tagA.id}`)).status).toBe(404);

    // Linking with A's tag id: 404 (tag not owned).
    const tagB = await createTagViaApi('我的');
    const foreignTag = await request('POST', `/${tagA.id}/links`, { entityType: 'event', entityId: 3 });
    expect(foreignTag.status).toBe(404);
    expect((await foreignTag.json()).code).toBe('tag_not_found');

    // Linking B's tag to A's entity id: 404 (entity not owned) - ids may collide across users.
    const foreignEntity = await request('POST', `/${tagB.id}/links`, { entityType: 'event', entityId: 1 });
    expect(foreignEntity.status).toBe(404);
    expect((await foreignEntity.json()).code).toBe('entity_not_found');

    // The smart filter is scoped to B: A's link to event 1 never leaks.
    const filterA = await request('GET', `entities?tagIds=${tagA.id}`);
    expect((await filterA.json()).data).toEqual([]);

    // B's own link still works and is the only row the filter sees.
    await request('POST', `/${tagB.id}/links`, { entityType: 'goal', entityId: 71 });
    const filterB = await request('GET', `entities?tagIds=${tagB.id}`);
    expect((await filterB.json()).data).toEqual([
      { entity_type: 'goal', entity_id: 71, tag_ids: [tagB.id] },
    ]);
    // A's data survived B's session untouched.
    expect(tags.some((tag) => tag.id === tagA.id && tag.name === '私密')).toBe(true);
    expect(links.some((link) => link.tag_id === tagA.id && link.entity_id === 1)).toBe(true);
  });
});

describe('smart filter: AND by default, OR on request (acceptance c)', () => {
  async function seedAbc(): Promise<{ a: TagRow; b: TagRow }> {
    const a = await createTagViaApi('A');
    const b = await createTagViaApi('B');
    // event 1 carries both; event 2 carries A; goal 70 carries B.
    await request('POST', `/${a.id}/links`, { entityType: 'event', entityId: 1 });
    await request('POST', `/${b.id}/links`, { entityType: 'event', entityId: 1 });
    await request('POST', `/${a.id}/links`, { entityType: 'event', entityId: 2 });
    await request('POST', `/${b.id}/links`, { entityType: 'goal', entityId: 70 });
    return { a, b };
  }

  it('two tags default to AND (both required) and mode=or returns the union - fixture counts', async () => {
    const { a, b } = await seedAbc();

    const andResponse = await request('GET', `entities?tagIds=${a.id},${b.id}`);
    const andBody = await andResponse.json();
    expect(andBody.mode).toBe('and');
    expect(andBody.data).toEqual([{ entity_type: 'event', entity_id: 1, tag_ids: [a.id, b.id] }]);
    expect(andBody.total).toBe(1);

    const orResponse = await request('GET', `entities?tagIds=${a.id},${b.id}&mode=or`);
    const orBody = await orResponse.json();
    expect(orBody.mode).toBe('or');
    expect(orBody.data).toEqual([
      { entity_type: 'event', entity_id: 1, tag_ids: [a.id, b.id] },
      { entity_type: 'event', entity_id: 2, tag_ids: [a.id] },
      { entity_type: 'goal', entity_id: 70, tag_ids: [b.id] },
    ]);
    expect(orBody.total).toBe(3);
  });

  it('composes the entity-type filter and the limit on top of the tag mode', async () => {
    const { a, b } = await seedAbc();

    const eventsOnly = await request('GET', `entities?tagIds=${a.id},${b.id}&mode=or&entityTypes=event`);
    const eventsBody = await eventsOnly.json();
    expect(eventsBody.entityTypes).toEqual(['event']);
    expect((eventsBody.data as TaggedEntityRow[]).map((row) => row.entity_id)).toEqual([1, 2]);

    const limited = await request('GET', `entities?tagIds=${a.id},${b.id}&mode=or&limit=1`);
    expect((await limited.json()).data).toHaveLength(1);
  });

  it('an empty tagIds selection returns an empty list, never the whole database', async () => {
    await seedAbc();
    const response = await request('GET', 'entities');
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('rejects malformed filter inputs with clear 400s', async () => {
    const { a } = await seedAbc();

    const badTagIds = await request('GET', 'entities?tagIds=abc');
    expect(badTagIds.status).toBe(400);
    expect((await badTagIds.json()).code).toBe('invalid_tag_ids');

    const badTypeList = await request('GET', `entities?tagIds=${a.id}&entityTypes=event,spaceship`);
    expect(badTypeList.status).toBe(400);
    expect((await badTypeList.json()).error).toContain('spaceship');

    const badMode = await request('GET', `entities?tagIds=${a.id}&mode=every`);
    expect(badMode.status).toBe(400);
    expect((await badMode.json()).code).toBe('invalid_tag_mode');
  });

  it('member chips: listEntityTags returns the entity\'s tags, name-ordered and scoped', async () => {
    const { a, b } = await seedAbc();
    const chips = await listEntityTags(1, 'event', 1);
    expect(chips.map((tag) => tag.name)).toEqual(['A', 'B']);
    expect(chips.map((tag) => tag.id)).toEqual([a.id, b.id]);
    // Another user asking for the same entity sees nothing (links are user-scoped).
    expect(await listEntityTags(2, 'event', 1)).toEqual([]);
  });
});

describe('buildTagFilterPredicate - the composition seam', () => {
  it('AND mode emits a counted subquery with offset parameter numbering', () => {
    const predicate = buildTagFilterPredicate('expiry_items.id', 3, 1, 'expiry', ['a', 'b'], 'and');
    expect(predicate).not.toBeNull();
    expect(predicate!.sql).toContain('expiry_items.id');
    expect(predicate!.sql).toContain('tl.user_id = $3');
    expect(predicate!.sql).toContain('tl.entity_type = $4');
    expect(predicate!.sql).toContain('t.name = ANY($5::text[])');
    expect(predicate!.sql).toContain('= $6');
    expect(predicate!.params).toEqual([1, 'expiry', ['a', 'b'], 2]);
  });

  it('OR mode emits EXISTS, dedupes names, and takes no count parameter', () => {
    const predicate = buildTagFilterPredicate('e.id', 5, 7, 'event', ['a', ' a ', 'b'], 'or');
    expect(predicate).not.toBeNull();
    expect(predicate!.sql.startsWith('EXISTS (')).toBe(true);
    expect(predicate!.params).toEqual([7, 'event', ['a', 'b']]);
  });

  it('no names -> null (no predicate, the caller keeps its own WHERE intact)', () => {
    expect(buildTagFilterPredicate('e.id', 1, 1, 'event', [], 'and')).toBeNull();
    expect(buildTagFilterPredicate('e.id', 1, 1, 'event', ['   '], 'or')).toBeNull();
  });

  it('an unknown entity type is a TagError with a 400 status', () => {
    expect(TAG_ENTITY_TYPES).toHaveLength(8);
    expect(() =>
      buildTagFilterPredicate('e.id', 1, 1, 'spaceship' as unknown as (typeof TAG_ENTITY_TYPES)[number], ['a']),
    ).toThrow(TagError);
  });
});
