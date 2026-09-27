import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 61 acceptance: the personal-CRM API surface on /api/contacts.
 *
 * - every verb is auth-guarded (401 without a token)
 * - every query is user-scoped; another user's contact is 404 (not 403)
 * - GET /due applies the cadence predicate: cadence_enabled AND cadence_days IS NOT NULL
 *   AND (effective last contact + cadence_days <= now); effective last contact is
 *   MAX(interactions.occurred_at) with a fallback to the stored column
 * - GET /:id/timeline pagination matches the /api/expiry convention
 * - POST interactions/promises/gifts + cadence fields on PUT
 *
 * The DB layer is mocked (no reachable Postgres in this environment) and the auth
 * middleware delegates to the real one when no user is seeded, so the 401 contract is
 * exercised for real. The SQL *semantics* (date arithmetic, CASCADE, backfill) are
 * proven against PGlite (WASM Postgres) in the live harness (see evidence file).
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

import contactRoutes from '../routes/contacts.js';

const USER = { id: 7, username: 'alice' };
const CONTACT_ID = 5;

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

type Responder = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number | null } | undefined;

function installDb(responder: Responder = () => undefined): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return responder(sql, params) ?? { rows: [], rowCount: 0 };
  });
}

function queriesMatching(pattern: RegExp): Captured[] {
  return captured.filter((q) => pattern.test(q.sql.replace(/\s+/g, ' ')));
}

function contactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONTACT_ID,
    user_id: USER.id,
    name: '张三',
    nickname: null,
    email: 'zhang@example.com',
    phone: null,
    telegram_chat_id: null,
    qq: null,
    wxpusher_uid: null,
    contact_methods: { emails: [{ label: '默认', value: 'zhang@example.com' }] },
    preferred_channels: [],
    relationship: '朋友',
    gender: 'unknown',
    notes: null,
    cadence_days: 30,
    last_contact_at: '2026-08-01T00:00:00.000Z',
    cadence_enabled: true,
    validation_status: 'valid',
    last_validated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Responder for the contact.service cases (PUT): ownership SELECT + UPDATE ... RETURNING * */
function contactServiceResponder(updateOverrides: Record<string, unknown> = {}): Responder {
  return (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/^SELECT \* FROM fixed_contacts WHERE id = \$1 AND user_id = \$2/.test(s)) {
      return { rows: [contactRow()], rowCount: 1 };
    }
    if (/^UPDATE fixed_contacts SET/.test(s)) {
      return { rows: [contactRow(updateOverrides)], rowCount: 1 };
    }
    return undefined;
  };
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await contactRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('D4 contacts API — auth guard', () => {
  it('returns 401 for every new verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/due'],
      ['GET', `/${CONTACT_ID}/timeline`],
      ['POST', `/${CONTACT_ID}/interactions`, { kind: 'call' }],
      ['POST', `/${CONTACT_ID}/promises`, { text: '打回去' }],
      ['POST', `/${CONTACT_ID}/gifts`, { description: '茶', direction: 'given' }],
    ];
    for (const [method, path, body] of cases) {
      const { status, body: json } = await request(method, path, body);
      expect(status, `${method} ${path}`).toBe(401);
      expect(json.error).toBe('Unauthorized');
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('GET /api/contacts/due', () => {
  it('returns the due contacts and scopes + filters in SQL (enabled AND days set AND overdue)', async () => {
    const due = contactRow({ cadence_days: 30, last_contact_at: '2026-07-01T00:00:00.000Z', effective_last_contact_at: '2026-07-01T00:00:00.000Z', next_due_at: '2026-07-31T00:00:00.000Z' });
    installDb((sql) => {
      if (sql.includes('FROM fixed_contacts fc')) return { rows: [due], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('GET', '/due');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);

    const [dueQuery] = queriesMatching(/FROM fixed_contacts fc/);
    expect(dueQuery).toBeDefined();
    const sql = dueQuery.sql.replace(/\s+/g, ' ');
    // user scoping
    expect(sql).toContain('fc.user_id = $1');
    // cadence_enabled=false must be excluded
    expect(sql).toContain('COALESCE(fc.cadence_enabled, FALSE) = TRUE');
    // failure scenario: cadence_days=null must be excluded (never "due every day")
    expect(sql).toContain('fc.cadence_days IS NOT NULL');
    // overdue arithmetic: stored column fallback + cadence days
    expect(sql).toContain('MAX(occurred_at)');
    expect(sql).toContain('fc.last_contact_at');
    expect(sql).toContain('make_interval(days => fc.cadence_days) <= NOW()');
    expect(dueQuery.params).toEqual([USER.id]);
  });

  it('the null-cadence guard is the only thing keeping a never-contacted contact out (mutation-proven live)', async () => {
    // Live proof (PGlite): seed contact A cadence_enabled=TRUE, cadence_days=NULL,
    // last_contact_at=NULL. A is excluded. Removing `fc.cadence_days IS NOT NULL`
    // from the service makes A appear (the NULL anchor branch would otherwise fire),
    // and the live harness fails -> see .omo/evidence/task-60-mutation-nullcadence.txt
    installDb((sql) => (sql.includes('FROM fixed_contacts fc') ? { rows: [], rowCount: 0 } : undefined));
    const { status, body } = await request('GET', '/due');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(queriesMatching(/FROM fixed_contacts fc/)[0].sql).toContain('fc.cadence_days IS NOT NULL');
  });
});

describe('GET /api/contacts/:id/timeline', () => {
  it('merges interactions/promises/gifts with the expiry pagination shape', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/^SELECT id FROM fixed_contacts WHERE id = \$1 AND user_id = \$2/.test(s)) {
        return { rows: [{ id: CONTACT_ID }], rowCount: 1 };
      }
      if (s.includes('::int AS count')) return { rows: [{ count: 5 }], rowCount: 1 };
      if (s.includes('UNION ALL')) {
        return {
          rows: [
            { type: 'interaction', id: 9, at: '2026-09-01T10:00:00.000Z', interaction_kind: 'call', summary: '打电话', mood: null },
            { type: 'promise', id: 2, at: '2026-08-20', promise_text: '一起吃饭', due_at: '2026-09-20', done_at: null },
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });

    const { status, body } = await request('GET', `/${CONTACT_ID}/timeline?page=2&limit=3`);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({ page: 2, limit: 3, total: 5, totalPages: 2 });

    const [countQuery] = queriesMatching(/::int AS count/);
    expect(countQuery.sql).toContain('FROM interactions WHERE user_id = $1 AND contact_id = $2');
    expect(countQuery.sql).toContain('FROM contact_promises WHERE contact_id = $2');
    expect(countQuery.sql).toContain('FROM gift_records WHERE contact_id = $2');

    const [timelineQuery] = queriesMatching(/UNION ALL/);
    const sql = timelineQuery.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('FROM interactions WHERE user_id = $1 AND contact_id = $2');
    expect(sql).toContain('ORDER BY at DESC');
    // page=2, limit=3 -> LIMIT 3 OFFSET 3 (last three params)
    expect(timelineQuery.params.slice(-2)).toEqual([3, 3]);
    expect(timelineQuery.params.slice(0, 2)).toEqual([USER.id, CONTACT_ID]);
  });

  it('caps limit at 200 (expiry convention)', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/^SELECT id FROM fixed_contacts/.test(s)) return { rows: [{ id: CONTACT_ID }], rowCount: 1 };
      if (s.includes('::int AS count')) return { rows: [{ count: 0 }], rowCount: 1 };
      return undefined;
    });

    await request('GET', `/${CONTACT_ID}/timeline?limit=9999`);
    const [timelineQuery] = queriesMatching(/UNION ALL/);
    expect(timelineQuery.params.slice(-2)).toEqual([200, 0]);
  });

  it("returns 404 for another user's contact and never reads its timeline", async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/^SELECT id FROM fixed_contacts WHERE id = \$1 AND user_id = \$2/.test(s)) {
        return { rows: [], rowCount: 0 };
      }
      return undefined;
    });

    const { status, body } = await request('GET', `/${CONTACT_ID}/timeline`);

    expect(status).toBe(404);
    expect(body.error).toBe('联系人不存在');
    expect(queriesMatching(/UNION ALL/)).toHaveLength(0);
    // The ownership probe really carried the caller's user id.
    const [ownership] = queriesMatching(/^SELECT id FROM fixed_contacts/);
    expect(ownership.params).toEqual([CONTACT_ID, USER.id]);
  });

  it('rejects an invalid id with 400', async () => {
    const { status } = await request('GET', '/abc/timeline');
    expect(status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/contacts/:id/interactions', () => {
  it('logs an interaction atomically scoped to the caller and advances last_contact_at', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/^INSERT INTO interactions/.test(s)) {
        return { rows: [{ id: 11, user_id: USER.id, contact_id: CONTACT_ID, kind: 'call', occurred_at: '2026-09-01T10:00:00.000Z', summary: '打电话', mood: '开心', created_at: '2026-09-01T10:00:00.000Z' }], rowCount: 1 };
      }
      if (/^UPDATE fixed_contacts SET last_contact_at/.test(s)) return { rows: [], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('POST', `/${CONTACT_ID}/interactions`, {
      kind: 'call',
      occurredAt: '2026-09-01T10:00:00.000Z',
      summary: '打电话',
      mood: '开心',
    });

    expect(status).toBe(201);
    expect((body.data as Record<string, unknown>).kind).toBe('call');

    const [insert] = queriesMatching(/^INSERT INTO interactions/);
    const insertSql = insert.sql.replace(/\s+/g, ' ');
    // atomic ownership: no separate check, the SELECT itself is user-scoped
    expect(insertSql).toContain('FROM fixed_contacts fc');
    expect(insertSql).toContain('WHERE fc.id = $2 AND fc.user_id = $1');
    expect(insert.params).toEqual([USER.id, CONTACT_ID, 'call', '2026-09-01T10:00:00.000Z', '打电话', '开心']);

    const [advance] = queriesMatching(/^UPDATE fixed_contacts SET last_contact_at/);
    const advanceSql = advance.sql.replace(/\s+/g, ' ');
    // forward-only: an older backfilled interaction must not move the anchor backwards
    expect(advanceSql).toContain('(last_contact_at IS NULL OR last_contact_at < $1)');
    expect(advance.params).toEqual(['2026-09-01T10:00:00.000Z', CONTACT_ID, USER.id]);
  });

  it('rejects a future occurred_at with 400 and writes nothing', async () => {
    const { status, body } = await request('POST', `/${CONTACT_ID}/interactions`, {
      kind: 'call',
      occurredAt: '2999-01-01T00:00:00.000Z',
      summary: '来自未来',
    });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('不能晚于当前时间');
    expect(queriesMatching(/^INSERT INTO interactions/)).toHaveLength(0);
  });

  it('rejects an unknown kind, a malformed occurred_at and a non-object body with 400', async () => {
    const badBodies: unknown[] = [
      { kind: 'smoke-signal' },
      { kind: 'call', occurredAt: 'not-a-date' },
      'just-a-string',
    ];
    for (const payload of badBodies) {
      const { status } = await request('POST', `/${CONTACT_ID}/interactions`, payload);
      expect(status, JSON.stringify(payload)).toBe(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's contact (0 rows inserted)", async () => {
    installDb((sql) => {
      if (sql.includes('INSERT INTO interactions')) return { rows: [], rowCount: 0 };
      return undefined;
    });

    const { status } = await request('POST', `/${CONTACT_ID}/interactions`, { kind: 'call' });
    expect(status).toBe(404);
    // no anchor update for a failed insert
    expect(queriesMatching(/^UPDATE fixed_contacts SET last_contact_at/)).toHaveLength(0);
  });

  it('treats a hostile summary/contact payload as data, never as SQL', async () => {
    const hostile = "Robert'); DROP TABLE interactions;-- <img src=x onerror=alert(1)>";
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/^INSERT INTO interactions/.test(s)) {
        return { rows: [{ id: 12, user_id: USER.id, contact_id: CONTACT_ID, kind: 'message', summary: hostile }], rowCount: 1 };
      }
      if (/^UPDATE fixed_contacts SET last_contact_at/.test(s)) return { rows: [], rowCount: 1 };
      return undefined;
    });

    const { status } = await request('POST', `/${CONTACT_ID}/interactions`, { kind: 'message', summary: hostile });
    expect(status).toBe(201);
    const [insert] = queriesMatching(/^INSERT INTO interactions/);
    expect(insert.sql).not.toContain('DROP TABLE');
    expect(insert.params[4]).toBe(hostile);
  });
});

describe('POST /api/contacts/:id/promises', () => {
  it('accepts a promise with a null due_at (someday) and scopes the insert by user', async () => {
    installDb((sql) => {
      if (sql.includes('INSERT INTO contact_promises')) {
        return { rows: [{ id: 3, contact_id: CONTACT_ID, text: '周末回电话', due_at: null, done_at: null, created_at: '2026-09-01T00:00:00.000Z' }], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('POST', `/${CONTACT_ID}/promises`, { text: '周末回电话', dueAt: null });

    expect(status).toBe(201);
    expect((body.data as Record<string, unknown>).due_at).toBeNull();

    const [insert] = queriesMatching(/INSERT INTO contact_promises/);
    const sql = insert.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('WHERE fc.id = $1 AND fc.user_id = $4');
    expect(insert.params).toEqual([CONTACT_ID, '周末回电话', null, USER.id]);
  });

  it('rejects an empty text and a bad due date with 400', async () => {
    expect((await request('POST', `/${CONTACT_ID}/promises`, { text: '' })).status).toBe(400);
    expect((await request('POST', `/${CONTACT_ID}/promises`, { text: 'x', dueAt: '31/12/2026' })).status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's contact", async () => {
    installDb((sql) => (sql.includes('INSERT INTO contact_promises') ? { rows: [], rowCount: 0 } : undefined));
    expect((await request('POST', `/${CONTACT_ID}/promises`, { text: 'x' })).status).toBe(404);
  });
});

describe('POST /api/contacts/:id/gifts', () => {
  it('records a given gift with amount and defaults the date in SQL', async () => {
    installDb((sql) => {
      if (sql.includes('INSERT INTO gift_records')) {
        return { rows: [{ id: 4, contact_id: CONTACT_ID, description: '茶叶', direction: 'given', occasion: '生日', amount_cents: '19900', occurred_at: '2026-09-01' }], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('POST', `/${CONTACT_ID}/gifts`, {
      description: '茶叶',
      direction: 'given',
      occasion: '生日',
      amountCents: 19900,
    });

    expect(status).toBe(201);
    expect((body.data as Record<string, unknown>).direction).toBe('given');

    const [insert] = queriesMatching(/INSERT INTO gift_records/);
    const sql = insert.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('COALESCE($6, CURRENT_DATE)');
    expect(sql).toContain('WHERE fc.id = $1 AND fc.user_id = $7');
    expect(insert.params).toEqual([CONTACT_ID, '茶叶', 'given', '生日', 19900, null, USER.id]);
  });

  it('rejects an unknown direction and a negative amount with 400', async () => {
    expect((await request('POST', `/${CONTACT_ID}/gifts`, { description: 'x', direction: 'stolen' })).status).toBe(400);
    expect((await request('POST', `/${CONTACT_ID}/gifts`, { description: 'x', direction: 'given', amountCents: -1 })).status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('PUT /api/contacts/:id — cadence fields', () => {
  it('applies a preset cadence and the enabled flag', async () => {
    installDb(contactServiceResponder({ cadence_days: 30, cadence_enabled: true }));

    const { status, body } = await request('PUT', `/${CONTACT_ID}`, { cadenceDays: 30, cadenceEnabled: true });

    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).cadence_days).toBe(30);

    const [update] = queriesMatching(/^UPDATE fixed_contacts SET/);
    const sql = update.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('cadence_days = $');
    expect(sql).toContain('cadence_enabled = $');
    expect(update.params).toContain(30);
    expect(update.params).toContain(true);
    // still scoped by the caller's user id (last two params)
    expect(update.params.slice(-2)).toEqual([CONTACT_ID, USER.id]);
  });

  it('accepts a custom cadence (45) and clears with null', async () => {
    installDb(contactServiceResponder({ cadence_days: 45 }));
    const custom = await request('PUT', `/${CONTACT_ID}`, { cadenceDays: 45 });
    expect(custom.status).toBe(200);
    expect(queriesMatching(/^UPDATE fixed_contacts SET/)[0].params).toContain(45);

    installDb(contactServiceResponder({ cadence_days: null }));
    const cleared = await request('PUT', `/${CONTACT_ID}`, { cadenceDays: null });
    expect(cleared.status).toBe(200);
    expect(queriesMatching(/^UPDATE fixed_contacts SET/)[0].params).toContain(null);
  });

  it('rejects cadence_days of 0, negative and non-numeric with 400 (no DB write)', async () => {
    const badValues: unknown[] = [0, -30, '30', 'monthly', 3.5];
    for (const cadenceDays of badValues) {
      const { status } = await request('PUT', `/${CONTACT_ID}`, { cadenceDays });
      expect(status, `cadenceDays=${String(cadenceDays)}`).toBe(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('rejects cadence_days above the 3650-day cap', async () => {
    const { status } = await request('PUT', `/${CONTACT_ID}`, { cadenceDays: 99999 });
    expect(status).toBe(400);
  });

  it('binds exactly one value per placeholder (regression: literal CURRENT_TIMESTAMP columns)', async () => {
    // The update builder used to increment the parameter index for the literal
    // `last_validated_at`/`updated_at` columns, so WHERE id=$i/user_id=$i+1 pointed
    // past the supplied values (every PUT failed against a real Postgres). The live
    // PGlite harness caught it; this locks the numbering.
    installDb(contactServiceResponder());
    await request('PUT', `/${CONTACT_ID}`, { notes: '备注', cadenceDays: 7 });

    const [update] = queriesMatching(/^UPDATE fixed_contacts SET/);
    const placeholders = [...update.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const max = Math.max(...placeholders);
    expect(max).toBe(update.params.length);
    expect(new Set(placeholders).size).toBe(max); // contiguous $1..$max, no gaps
    expect(update.sql).toContain('last_validated_at = CURRENT_TIMESTAMP');
    expect(update.params.slice(-2)).toEqual([CONTACT_ID, USER.id]);
  });
});
