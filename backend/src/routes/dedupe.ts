import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  DEDUPE_CONTACT_MIN_SCORE_DEFAULT,
  DEDUPE_EVENT_MIN_SCORE_DEFAULT,
  DEDUPE_LIST_DEFAULT_LIMIT,
  DEDUPE_LIST_MAX_LIMIT,
  findSimilarContacts,
  findSimilarEvents,
  proposeContactMerge,
} from '../services/agent/dedupe.service.js';

/**
 * Task 135 API — duplicate candidates (events + contacts) and the merge
 * PROPOSAL. Scans are read-only; merging a contact duplicate goes through a
 * task-126 decision card (Approve / Edit / Reject) and the shipped
 * `merge_contacts` resolver. Nothing is ever auto-deleted.
 *
 * GET  /api/dedupe                       both scans, ranked
 * GET  /api/dedupe/events                event duplicates only
 * GET  /api/dedupe/contacts              contact duplicates only
 * POST /api/dedupe/contacts/propose-merge  open a merge decision card
 *
 * The integrator mounts this router at `/api/dedupe` (see the 135-142 note).
 */
const dedupe = new Hono<{ Variables: { user: User } }>();
dedupe.use('*', authMiddleware);

function readLimit(c: Context): number {
  const parsed = Number.parseInt(c.req.query('limit') ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, DEDUPE_LIST_MAX_LIMIT) : DEDUPE_LIST_DEFAULT_LIMIT;
}

function readMinScore(c: Context, fallback: number): number {
  const parsed = Number(c.req.query('minScore'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

const proposeMergeSchema = z.object({
  keepContactId: z.number().int().positive(),
  mergeContactId: z.number().int().positive(),
  timezone: z.string().min(1).max(64).optional(),
});

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// GET /api/dedupe — ranked event + contact candidates in one response.
dedupe.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const limit = readLimit(c);
  const [events, contacts] = await Promise.all([
    findSimilarEvents(userId, { limit, minScore: readMinScore(c, DEDUPE_EVENT_MIN_SCORE_DEFAULT) }),
    findSimilarContacts(userId, { limit, minScore: readMinScore(c, DEDUPE_CONTACT_MIN_SCORE_DEFAULT) }),
  ]);
  return c.json({
    success: true,
    data: {
      events,
      contacts,
      note: '联系人合并需通过决定卡审批；系统不会自动删除任何数据',
    },
  });
});

// GET /api/dedupe/events
dedupe.get('/events', async (c) => {
  const userId = Number(c.get('user').id);
  const candidates = await findSimilarEvents(userId, {
    limit: readLimit(c),
    minScore: readMinScore(c, DEDUPE_EVENT_MIN_SCORE_DEFAULT),
  });
  return c.json({ success: true, data: candidates });
});

// GET /api/dedupe/contacts
dedupe.get('/contacts', async (c) => {
  const userId = Number(c.get('user').id);
  const candidates = await findSimilarContacts(userId, {
    limit: readLimit(c),
    minScore: readMinScore(c, DEDUPE_CONTACT_MIN_SCORE_DEFAULT),
  });
  return c.json({ success: true, data: candidates });
});

// POST /api/dedupe/contacts/propose-merge — creates a decision card; applies NOTHING.
dedupe.post('/contacts/propose-merge', async (c) => {
  const parsed = proposeMergeSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, code: 'invalid_request', error: '请求参数无效', details: parsed.error.flatten() },
      400,
    );
  }

  const result = await proposeContactMerge({
    userId: Number(c.get('user').id),
    keepContactId: parsed.data.keepContactId,
    mergeContactId: parsed.data.mergeContactId,
    timezone: parsed.data.timezone,
  });

  switch (result.status) {
    case 'proposed':
      return c.json({ success: true, data: result }, 201);
    case 'existing':
    case 'suppressed':
      return c.json({ success: true, data: result });
    case 'target_missing':
      return c.json({ success: false, code: 'target_missing', error: result.message }, 404);
    case 'invalid':
      return c.json({ success: false, code: 'invalid_request', error: result.message }, 400);
  }
});

export default dedupe;
