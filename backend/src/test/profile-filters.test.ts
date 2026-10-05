import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 69 acceptance, part 2: profile-aware queries without breaking callers.
 *
 * - 2 profiles with 1 event each: no filter -> 2 events; profileId=A -> 1.
 * - an invalid / foreign / archived profile id -> 404 on EVERY touched route,
 *   never a leak (parameterised over events, contacts, expiry, inventory,
 *   maintenance, documents, habits, todos).
 * - REGRESSION: omitting `profileId` keeps the pre-change API shape AND emits
 *   zero profile predicates (no `FROM profiles` probe, no `profile_id = $n`).
 * - the ownership probe SQL carries `user_id = $2`; removing that predicate
 *   would make the leak-detection assertions fail (mutation-checked live).
 *
 * The DB is mocked here; the real SQL predicates run against PGlite in the
 * live harness (harness-filters).
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

import eventsRoutes from '../routes/events.js';
import contactsRoutes from '../routes/contacts.js';
import expiryRoutes from '../routes/expiry.js';
import inventoryRoutes from '../routes/inventory.js';
import maintenanceRoutes from '../routes/maintenance.js';
import documentsRoutes from '../routes/documents.js';
import habitsRoutes from '../routes/habits.js';
import todosRoutes from '../routes/todos.js';

const USER = { id: 1, username: 'alice' };
const SELF = 11;
const FAMILY = 12;
const ARCHIVED = 13;
const FOREIGN = 21;

interface ScopedRow {
  id?: number | string;
  event_id?: number;
  user_id: number;
  profile_id?: number | null;
  [key: string]: unknown;
}

let captured: Array<{ sql: string; params: unknown[] }>;
let events: ScopedRow[];
let contacts: ScopedRow[];
let expiry: ScopedRow[];
let inventory: ScopedRow[];
let maintenance: ScopedRow[];
let documents: ScopedRow[];
let habits: ScopedRow[];
let completions: ScopedRow[];

const PROFILES = [
  { id: SELF, user_id: 1, kind: 'self', name: '我', is_active: true },
  { id: FAMILY, user_id: 1, kind: 'family', name: '小明', is_active: true },
  { id: ARCHIVED, user_id: 1, kind: 'family', name: '归档', is_active: false },
  { id: FOREIGN, user_id: 2, kind: 'self', name: '我', is_active: true },
];

function eventRow(id: number, userId: number, profileId: number, name: string): ScopedRow {
  return {
    id,
    user_id: userId,
    profile_id: profileId,
    name,
    type: 'other',
    date: '2026-10-01',
    calendar_type: 'gregorian',
    lunar_date: null,
    reminder_config: null,
    notification_channels: [],
    notification_account_ids: null,
    created_at: null,
  };
}

function installDb(): void {
  captured = [];
  events = [
    eventRow(101, 1, SELF, 'alice self event'),
    eventRow(102, 1, FAMILY, 'alice family event'),
    eventRow(103, 2, FOREIGN, 'bob event'),
  ];
  const mk = (prefix: string): ScopedRow[] => [
    { id: `${prefix}-1`, user_id: 1, profile_id: SELF, title: `${prefix} self`, name: `${prefix} self`, asset_name: `${prefix} self` },
    { id: `${prefix}-2`, user_id: 1, profile_id: FAMILY, title: `${prefix} family`, name: `${prefix} family`, asset_name: `${prefix} family` },
    { id: `${prefix}-3`, user_id: 2, profile_id: FOREIGN, title: `${prefix} foreign`, name: `${prefix} foreign`, asset_name: `${prefix} foreign` },
  ];
  contacts = [
    { id: 'c-1', user_id: 1, profile_id: SELF, name: 'self contact' },
    { id: 'c-2', user_id: 1, profile_id: FAMILY, name: 'family contact' },
    { id: 'c-3', user_id: 2, profile_id: FOREIGN, name: 'foreign contact' },
  ];
  expiry = mk('expiry');
  inventory = mk('inventory');
  maintenance = mk('maintenance');
  documents = mk('document');
  habits = [
    { id: 'h-1', user_id: 1, profile_id: SELF, name: 'self habit' },
    { id: 'h-2', user_id: 1, profile_id: FAMILY, name: 'family habit' },
    { id: 'h-3', user_id: 2, profile_id: FOREIGN, name: 'foreign habit' },
  ];
  completions = [
    { event_id: 101, user_id: 1, occurrence_date: '2026-10-01', completed_at: '2026-10-01T08:00:00Z' },
    { event_id: 102, user_id: 1, occurrence_date: '2026-10-01', completed_at: '2026-10-01T09:00:00Z' },
    { event_id: 103, user_id: 2, occurrence_date: '2026-10-01', completed_at: '2026-10-01T10:00:00Z' },
  ];

  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    const userId = Number(params[0]);
    const profileFilter = requestedProfile(s, params);

    if (s.startsWith('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2 AND is_active = TRUE')) {
      const row = PROFILES.find(
        (p) => p.id === Number(params[0]) && p.user_id === Number(params[1]) && p.is_active,
      );
      return row ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM profiles')) {
      throw new Error(`unexpected profiles query: ${s}`);
    }

    const scoped = (table: ScopedRow[]): ScopedRow[] =>
      table.filter((r) => r.user_id === userId && (profileFilter === null || r.profile_id === profileFilter));

    if (s.includes('COUNT(*) OVER() AS total_count FROM events')) {
      // v2.27：events 列表合并为单条 SQL（COUNT OVER + COALESCE 参数化档案过滤）
      const rows = scoped(events).map((r, i) =>
        i === 0 ? { ...r, total_count: scoped(events).length } : r,
      );
      return { rows, rowCount: rows.length };
    }
    if (s.includes('SELECT COUNT(*) as total FROM events')) {
      const rows = scoped(events);
      return { rows: [{ total: rows.length }], rowCount: 1 };
    }
    if (s.includes('SELECT * FROM events WHERE')) {
      const rows = scoped(events);
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM fixed_contacts')) {
      const rows = scoped(contacts).map((r) => ({
        ...r,
        email: null, phone: null, telegram_chat_id: null, qq: null, wxpusher_uid: null,
        contact_methods: {}, preferred_channels: [], relationship: null, gender: 'unknown', notes: null,
        cadence_days: null, last_contact_at: null, cadence_enabled: false,
        validation_status: 'valid', last_validated_at: null, created_at: null, updated_at: null,
      }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM expiry_items')) {
      const rows = scoped(expiry).map((r) => ({
        ...r, kind: 'custom', vendor: null, amount_cents: null, currency: 'CNY', cycle: 'once',
        cycle_days: null, start_date: null, next_due_date: '2026-10-01', auto_renew: false,
        notes: null, tags: [], reminder_config: null, is_active: true, created_at: null, updated_at: null,
      }));
      if (s.startsWith('SELECT COUNT(*)')) return { rows: [{ count: rows.length }], rowCount: 1 };
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM inventory_items')) {
      const rows = scoped(inventory).map((r) => ({
        ...r, category: 'other', quantity: 1, unit: null, low_stock_threshold: null, purchased_at: null,
        expires_at: null, location: null, notes: null, reminder_config: null, is_active: true,
        created_at: null, updated_at: null,
      }));
      if (s.startsWith('SELECT COUNT(*)')) return { rows: [{ count: rows.length }], rowCount: 1 };
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM maintenance_plans')) {
      const rows = scoped(maintenance).map((r) => ({
        ...r, asset_kind: 'other', interval_days: 30, interval_usage: null, usage_unit: null,
        current_usage: null, last_done_at: null, next_due_at: '2026-10-01', next_due_usage: null,
        notes: null, reminder_config: null, is_active: true, created_at: null, updated_at: null,
      }));
      if (s.startsWith('SELECT COUNT(*)')) return { rows: [{ count: rows.length }], rowCount: 1 };
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM documents')) {
      const rows = scoped(documents).map((r) => ({
        ...r, kind: 'other', issuer: null, document_number_encrypted: null, issued_at: null,
        expires_at: null, country: null, notes: null, reminder_config: null, is_active: true,
        created_at: null, updated_at: null,
      }));
      if (s.startsWith('SELECT COUNT(*)')) return { rows: [{ count: rows.length }], rowCount: 1 };
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM habits WHERE user_id')) {
      const rows = scoped(habits).map((r) => ({
        ...r, icon: null, target_per_period: 1, period: 'day', schedule_days: null,
        reminder_times: null, color: null, is_active: true, created_at: '2026-06-01', updated_at: '2026-06-01',
      }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM habit_logs')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM user_configs')) {
      return { rows: [{ timezone: 'Asia/Shanghai' }], rowCount: 1 };
    }
    if (s.includes('FROM todo_completions')) {
      const rows = completions.filter((c) => {
        if (c.user_id !== userId) return false;
        if (profileFilter === null) return true;
        return events.find((e) => e.id === c.event_id)?.profile_id === profileFilter;
      });
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected SQL: ${s}`);
  });
}

function requestedProfile(sql: string, params: unknown[]): number | null {
  // v2.27：events 单条 SQL 用 COALESCE($n::int, profile_id) 参数化——参数为 null 即"无过滤"。
  const co = sql.match(/profile_id = COALESCE\(\$(\d+)::int, profile_id\)/);
  if (co) {
    const v = params[Number(co[1]) - 1];
    return v == null ? null : Number(v);
  }
  const m = sql.match(/profile_id = \$(\d+)/);
  if (!m) return null;
  const v = params[Number(m[1]) - 1];
  return v == null ? null : Number(v);
}

interface RouteCase {
  name: string;
  route: { request: (input: string) => Promise<Response> | Response };
  path: string;
  /** 分页返回 `{success,data,pagination}`；其余为 `{success,data}` */
  paginated?: boolean;
}

const ROUTES: RouteCase[] = [
  { name: 'events', route: eventsRoutes, path: '/', paginated: true },
  { name: 'contacts', route: contactsRoutes, path: '/' },
  { name: 'expiry', route: expiryRoutes, path: '/', paginated: true },
  { name: 'inventory', route: inventoryRoutes, path: '/', paginated: true },
  { name: 'maintenance', route: maintenanceRoutes, path: '/', paginated: true },
  { name: 'documents', route: documentsRoutes, path: '/', paginated: true },
  { name: 'habits', route: habitsRoutes, path: '/' },
  { name: 'todos', route: todosRoutes, path: '/completions' },
];

async function getJson(routeCase: RouteCase, query: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await routeCase.route.request(`http://localhost${routeCase.path}${query}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  installDb();
  authState.user = { ...USER };
});

describe('profile-aware list queries (checkbox 69)', () => {
  it('acceptance: 2 profiles with 1 event each - no filter -> 2, profileId=A -> 1, foreign -> 404', async () => {
    const all = await getJson(ROUTES[0], '');
    expect(all.status).toBe(200);
    expect((all.json.data as unknown[]).length).toBe(2);
    expect(all.json.pagination).toMatchObject({ total: 2, page: 1, limit: 50, totalPages: 1 });

    const self = await getJson(ROUTES[0], `?profileId=${SELF}`);
    expect(self.status).toBe(200);
    expect((self.json.data as unknown[]).length).toBe(1);
    expect((self.json.data as Array<{ name: string }>)[0].name).toBe('alice self event');
    expect(self.json.pagination).toMatchObject({ total: 1 });

    const family = await getJson(ROUTES[0], `?profileId=${FAMILY}`);
    expect((family.json.data as unknown[]).length).toBe(1);
    expect((family.json.data as Array<{ name: string }>)[0].name).toBe('alice family event');

    const foreign = await getJson(ROUTES[0], `?profileId=${FOREIGN}`);
    expect(foreign.status).toBe(404);
    expect(foreign.json.data).toBeUndefined();
  });

  it('regression: omitting profileId keeps the pre-change response shape and adds no predicate', async () => {
    for (const routeCase of ROUTES) {
      captured = [];
      const { status, json } = await getJson(routeCase, '');
      expect(status, routeCase.name).toBe(200);
      expect(json.success, routeCase.name).toBe(true);
      if (routeCase.paginated) {
        expect(Object.keys(json).sort()).toEqual(['data', 'pagination', 'success']);
        expect(json.pagination, routeCase.name).toMatchObject({ page: 1, limit: 50, total: 2, totalPages: 1 });
      } else {
        expect(Object.keys(json).sort()).toEqual(['data', 'success']);
      }
      expect((json.data as unknown[]).length, routeCase.name).toBe(2);

      // No ownership probe and no profile predicate when the parameter is absent.
      expect(
        captured.some((q) => q.sql.includes('FROM profiles')),
        `${routeCase.name} probed profiles without profileId`,
      ).toBe(false);
      // v2.27：events 路由的档案过滤改为 COALESCE 参数化（参数 null = 无过滤，
      // 语义不变）；其余路由仍断言完全没有 profile 谓词。
      expect(
        captured.some((q) => {
          if (routeCase.name === 'events') {
            return /profile_id = COALESCE\(\$\d+::int, profile_id\)/.test(q.sql)
              && requestedProfile(q.sql, q.params as unknown[]) !== null;
          }
          return /profile_id = \$/.test(q.sql);
        }),
        `${routeCase.name} filtered by profile without profileId`,
      ).toBe(false);
      // The todo completion query must not gain a subquery either.
      if (routeCase.name === 'todos') {
        expect(captured.some((q) => q.sql.includes('SELECT id FROM events'))).toBe(false);
      }
    }
  });

  it('filters every touched route to the requested profile (owned self / family)', async () => {
    for (const routeCase of ROUTES) {
      const self = await getJson(routeCase, `?profileId=${SELF}`);
      expect(self.status, `${routeCase.name} self`).toBe(200);
      expect((self.json.data as unknown[]).length, `${routeCase.name} self`).toBe(1);

      const family = await getJson(routeCase, `?profileId=${FAMILY}`);
      expect(family.status, `${routeCase.name} family`).toBe(200);
      expect((family.json.data as unknown[]).length, `${routeCase.name} family`).toBe(1);
    }
  });

  it('rejects another user profile with 404 on every touched route - never a leak', async () => {
    for (const routeCase of ROUTES) {
      const { status, json } = await getJson(routeCase, `?profileId=${FOREIGN}`);
      expect(status, `${routeCase.name} foreign profile`).toBe(404);
      expect(json.success, routeCase.name).toBe(false);
      expect(json.data, `${routeCase.name} must not leak data on 404`).toBeUndefined();
      expect(JSON.stringify(json), `${routeCase.name} 404 body`).not.toContain('foreign');
    }
  });

  it('rejects an archived (inactive) own profile with 404 on every touched route', async () => {
    for (const routeCase of ROUTES) {
      const { status, json } = await getJson(routeCase, `?profileId=${ARCHIVED}`);
      expect(status, `${routeCase.name} archived profile`).toBe(404);
      expect(json.data, routeCase.name).toBeUndefined();
    }
  });

  it('rejects malformed profile ids with 404 (never a 500, never unfiltered data)', async () => {
    for (const raw of ['abc', '0', '-3', '12.5', '1e3', ' ', 'null', 'NaN']) {
      const { status, json } = await getJson(ROUTES[0], `?profileId=${encodeURIComponent(raw)}`);
      expect(status, `profileId=${JSON.stringify(raw)}`).toBe(404);
      expect(json.data, `profileId=${JSON.stringify(raw)}`).toBeUndefined();
    }
  });

  it('ownership probe SQL is user-scoped (removing `user_id = $2` makes this fail)', async () => {
    captured = [];
    await getJson(ROUTES[0], `?profileId=${FOREIGN}`);

    const probes = captured.filter((q) => q.sql.includes('FROM profiles WHERE id ='));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe.sql).toContain('user_id = $2');
      expect(probe.params).toEqual([FOREIGN, 1]);
    }
  });

  it('keeps hostile profile ids as parameters, never interpolated', async () => {
    captured = [];
    const payload = "1; DROP TABLE profiles;--";
    await getJson(ROUTES[0], `?profileId=${encodeURIComponent(payload)}`);
    expect(captured.some((q) => q.sql.includes('DROP TABLE'))).toBe(false);
  });
});
