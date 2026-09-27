import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 72 acceptance, part 1: medication HTTP contract.
 *
 * The route layer validates input (unitsPerDose=0, negative stock, bad form,
 * end<start, duplicate schedule times), maps domain results to status codes
 * (future dose -> 400, foreign/unknown -> 404, invalid profile -> 404) and
 * never leaks another user's rows.
 *
 * The stock / adherence / refill arithmetic is NOT re-asserted here - it is
 * proven against a real Postgres engine (PGlite) in the live harness
 * (`.omo/evidence/task-70-live-pglite.txt`), where numerical assertions are
 * meaningful rather than re-stating a mock's own arithmetic.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(c, next);
    },
  };
});

const svc = vi.hoisted(() => ({
  listMedications: vi.fn(),
  getMedication: vi.fn(),
  createMedication: vi.fn(),
  updateMedication: vi.fn(),
  deleteMedication: vi.fn(),
  getTodayDoses: vi.fn(),
  getAdherence: vi.fn(),
  getRefills: vi.fn(),
  logDose: vi.fn(),
  snoozeDose: vi.fn(),
}));
vi.mock('../services/medication.service.js', () => svc);

import medicationsRoutes from '../routes/medications.js';
import dosesRoutes from '../routes/doses.js';

const USER = { id: 1, username: 'alice' };
const MED = { id: 5, user_id: 1, name: '二甲双胍', schedule_times: ['08:00', '20:00'] };
const DOSE = { id: 9, medication_id: 5, user_id: 1, status: 'taken', scheduled_for: '2026-09-28T00:00:00.000Z' };

async function call(
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

beforeEach(() => {
  authState.user = { ...USER };
  for (const fn of Object.values(svc)) fn.mockReset();
  dbQuery.mockReset();
  // parseProfileFilter -> findOwnedProfile: only profile 11 is owned by user 1.
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM profiles WHERE id = $1 AND user_id = $2 AND is_active = TRUE')) {
      const owned = Number(params[0]) === 11 && Number(params[1]) === 1;
      return owned ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe('/api/medications (checkbox 72)', () => {
  it('is auth-guarded on every verb', async () => {
    authState.user = null;
    for (const [app, method, path] of [
      [medicationsRoutes, 'GET', '/'],
      [medicationsRoutes, 'GET', '/today'],
      [medicationsRoutes, 'GET', '/refills'],
      [medicationsRoutes, 'POST', '/'],
      [medicationsRoutes, 'GET', '/5'],
      [medicationsRoutes, 'PATCH', '/5'],
      [medicationsRoutes, 'DELETE', '/5'],
      [dosesRoutes, 'POST', '/9/log'],
      [dosesRoutes, 'POST', '/9/snooze'],
    ] as const) {
      expect((await call(app, method, path)).status, `${method} ${path}`).toBe(401);
    }
  });

  it('POST / rejects malformed medications (400) without touching the service', async () => {
    const cases: Array<Record<string, unknown>> = [
      { name: '   ', startDate: '2026-09-01' }, // empty name
      { name: 'x', startDate: '2026-09-01', unitsPerDose: 0 }, // 0 units per dose
      { name: 'x', startDate: '2026-09-01', unitsPerDose: -1 },
      { name: 'x', startDate: '2026-10-01', endDate: '2026-09-01' }, // end < start
      { name: 'x', startDate: '2026-09-01', stockQuantity: -5 }, // negative stock
      { name: 'x', startDate: '2026-09-01', form: 'potion' }, // bad form
      { name: 'x', startDate: 'not-a-date' },
      { name: 'x', startDate: '2026-09-01', scheduleTimes: ['25:00'] },
    ];
    for (const body of cases) {
      const res = await call(medicationsRoutes, 'POST', '/', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(svc.createMedication).not.toHaveBeenCalled();
  });

  it('POST / dedupes and sorts scheduleTimes before persisting', async () => {
    svc.createMedication.mockResolvedValue({ ...MED, schedule_times: ['08:00', '20:00'] });
    const res = await call(medicationsRoutes, 'POST', '/', {
      name: '二甲双胍',
      startDate: '2026-09-01',
      scheduleTimes: ['20:00', '08:00', '08:00'],
    });
    expect(res.status).toBe(201);
    const [, input] = svc.createMedication.mock.calls[0] as [number, { scheduleTimes: string[] }];
    expect(input.scheduleTimes).toEqual(['08:00', '20:00']);
  });

  it('GET / and /today 404 a foreign / unknown profileId (no leak)', async () => {
    expect((await call(medicationsRoutes, 'GET', '/?profileId=999')).status).toBe(404);
    expect((await call(medicationsRoutes, 'GET', '/today?profileId=21')).status).toBe(404);
    expect((await call(medicationsRoutes, 'GET', '/refills?profileId=abc')).status).toBe(404);
    expect(svc.listMedications).not.toHaveBeenCalled();
    expect(svc.getTodayDoses).not.toHaveBeenCalled();
  });

  it('GET / passes the owned profileId through', async () => {
    svc.listMedications.mockResolvedValue([MED]);
    const res = await call(medicationsRoutes, 'GET', '/?profileId=11&active=true');
    expect(res.status).toBe(200);
    expect(svc.listMedications).toHaveBeenCalledWith(1, { active: true, profileId: 11 });
  });

  it('GET /:id 404s unknown / foreign rows and 400s malformed ids', async () => {
    svc.getMedication.mockResolvedValue(null);
    expect((await call(medicationsRoutes, 'GET', '/999')).status).toBe(404);
    expect((await call(medicationsRoutes, 'GET', '/abc')).status).toBe(400);
    svc.getMedication.mockResolvedValue({ ...MED });
    expect((await call(medicationsRoutes, 'GET', '/5')).status).toBe(200);
  });

  it('GET /adherence validates the window and rejects from > to', async () => {
    expect((await call(medicationsRoutes, 'GET', '/adherence?from=2026-09-01&to=bad')).status).toBe(400);
    expect((await call(medicationsRoutes, 'GET', '/adherence?from=2026-09-30&to=2026-09-01')).status).toBe(400);
    svc.getAdherence.mockResolvedValue({ from: '2026-09-01', to: '2026-09-02', overall: {}, medications: [] });
    const ok = await call(medicationsRoutes, 'GET', '/adherence?from=2026-09-01&to=2026-09-02');
    expect(ok.status).toBe(200);
    expect(svc.getAdherence).toHaveBeenCalledWith(1, '2026-09-01', '2026-09-02', { profileId: null });
  });

  it('PATCH /:id validates input and 404s unknown rows', async () => {
    expect((await call(medicationsRoutes, 'PATCH', '/5', { unitsPerDose: 0 })).status).toBe(400);
    svc.updateMedication.mockResolvedValue(null);
    expect((await call(medicationsRoutes, 'PATCH', '/5', { name: 'x' })).status).toBe(404);
    svc.updateMedication.mockResolvedValue({ ...MED, name: 'x' });
    expect((await call(medicationsRoutes, 'PATCH', '/5', { name: 'x' })).status).toBe(200);
  });

  it('DELETE /:id maps unknown rows to 404', async () => {
    svc.deleteMedication.mockResolvedValue(false);
    expect((await call(medicationsRoutes, 'DELETE', '/9')).status).toBe(404);
    svc.deleteMedication.mockResolvedValue(true);
    expect((await call(medicationsRoutes, 'DELETE', '/9')).status).toBe(200);
  });
});

describe('/api/doses/:id/log (checkbox 72)', () => {
  it('rejects an unknown status (400) and a malformed id (400)', async () => {
    expect((await call(dosesRoutes, 'POST', '/9/log', { status: 'pending' })).status).toBe(400);
    expect((await call(dosesRoutes, 'POST', '/9/log', { status: 'missed' })).status).toBe(400);
    expect((await call(dosesRoutes, 'POST', '/abc/log', { status: 'taken' })).status).toBe(400);
    expect(svc.logDose).not.toHaveBeenCalled();
  });

  it('400s a future dose and 404s an unknown/foreign dose', async () => {
    svc.logDose.mockResolvedValueOnce({ status: 'future_dose', scheduledFor: '2030-01-01T00:00:00.000Z' });
    const future = await call(dosesRoutes, 'POST', '/9/log', { status: 'taken' });
    expect(future.status).toBe(400);
    expect(String(future.json.error)).toContain('未来剂量');

    svc.logDose.mockResolvedValueOnce({ status: 'not_found' });
    expect((await call(dosesRoutes, 'POST', '/9/log', { status: 'taken' })).status).toBe(404);
  });

  it('200s a valid log with the updated dose + stock', async () => {
    svc.logDose.mockResolvedValue({ status: 'ok', dose: DOSE, stockQuantity: 9.5 });
    const res = await call(dosesRoutes, 'POST', '/9/log', { status: 'taken', note: '早餐后' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ dose: { id: 9, status: 'taken' }, stockQuantity: 9.5 });
    expect(svc.logDose).toHaveBeenCalledWith(1, 9, { status: 'taken', note: '早餐后' });
  });

  it('POST /:id/snooze maps not_found -> 404, already_logged -> 409, ok -> 200', async () => {
    svc.snoozeDose.mockResolvedValueOnce({ status: 'not_found' });
    expect((await call(dosesRoutes, 'POST', '/9/snooze')).status).toBe(404);

    svc.snoozeDose.mockResolvedValueOnce({ status: 'already_logged' });
    expect((await call(dosesRoutes, 'POST', '/9/snooze')).status).toBe(409);

    svc.snoozeDose.mockResolvedValueOnce({ status: 'ok', doseId: 9, snoozedUntil: '2026-09-28T08:10:00.000Z' });
    const ok = await call(dosesRoutes, 'POST', '/9/snooze');
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ doseId: 9, snoozedUntil: '2026-09-28T08:10:00.000Z' });
    expect((await call(dosesRoutes, 'POST', '/abc/snooze')).status).toBe(400);
  });
});
