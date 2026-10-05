import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { isValidIanaTimezone } from '../utils/timezone.js';
import {
  DECISION_SUBJECT_KINDS,
  checkQuestionCardCap,
  decideOnDecisionCard,
  getDecisionCard,
  listDecisionCards,
  loadUserTimezone,
  proposeDecision,
  type DecideOnDecisionCardResult,
  type DecisionStatus,
  type DecisionSubjectKind,
} from '../services/agent/decision-card.service.js';
import {
  POLICY_DIGEST_MAX_CHARS,
  buildPolicyDigest,
} from '../services/agent/feedback.service.js';

/**
 * Task 126 API — decision cards (propose / list / approve / edit / reject) and
 * the task 127 policy-memory surface (bounded digest + question-card cap).
 *
 * The integrator mounts this router at `/api/decisions` (see the 126-127 note).
 */
const decisions = new Hono<{ Variables: { user: User } }>();
decisions.use('*', authMiddleware);

const subjectKindSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => (DECISION_SUBJECT_KINDS as readonly string[]).includes(value), {
    message: 'unknown_subject_kind',
  });

const proposeSchema = z.object({
  subjectKind: subjectKindSchema,
  subjectRef: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(500),
  payload: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200),
  isQuestion: z.boolean().optional(),
  timezone: z.string().min(1).max(64).refine(isValidIanaTimezone, { message: 'Invalid IANA timezone' }).optional(),
});

const rationaleSchema = z.object({
  rationale: z.string().max(500).optional(),
});

const editSchema = z.object({
  rationale: z.string().max(500).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const STATUSES: readonly DecisionStatus[] = ['pending', 'approved', 'rejected', 'target_missing', 'expired'];

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function parseCardId(c: Context): number | null {
  const parsed = Number(c.req.param('id'));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Outcome -> HTTP mapping shared by approve / edit / reject. */
function decideResponse(c: Context, result: DecideOnDecisionCardResult): Response {
  switch (result.outcome) {
    case 'approved':
    case 'edited':
    case 'rejected':
      return c.json({
        success: true,
        data: {
          outcome: result.outcome,
          status: result.card?.status ?? null,
          card: result.card,
        },
      });
    case 'already_decided':
      return c.json({ success: false, code: 'already_decided', error: '该决定已处理' }, 409);
    case 'target_missing':
      return c.json({ success: false, code: 'target_missing', error: '目标已不存在' }, 404);
    case 'not_found':
      return c.json({ success: false, code: 'not_found', error: '该决定已不存在' }, 404);
    case 'invalid_payload':
      return c.json({ success: false, code: 'invalid_payload', error: '提议内容无效，无法执行' }, 400);
    default:
      return c.json({ success: false, code: 'apply_failed', error: '执行失败，请稍后重试' }, 500);
  }
}

// POST /api/decisions — propose a card (Inbox + budget-gated push; nothing mutates yet).
decisions.post('/', async (c) => {
  const body = await readJsonBody(c);
  const parsed = proposeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, code: 'invalid_request', error: '请求参数无效', details: parsed.error.flatten() }, 400);
  }
  const userId = Number(c.get('user').id);
  const result = await proposeDecision({
    userId,
    subjectKind: parsed.data.subjectKind as DecisionSubjectKind,
    subjectRef: parsed.data.subjectRef ?? null,
    summary: parsed.data.summary,
    payload: parsed.data.payload ?? {},
    idempotencyKey: parsed.data.idempotencyKey,
    isQuestion: parsed.data.isQuestion === true,
    timezone: parsed.data.timezone,
  });

  if (result.outcome === 'suppressed') {
    const message = result.reason === 'question_card_cap'
      ? '今日提问卡片已达上限'
      : '该提议此前已被拒绝，已按政策记忆抑制';
    return c.json({ success: true, data: { ...result, message } });
  }
  return c.json({ success: true, data: result }, result.outcome === 'created' ? 201 : 200);
});

// GET /api/decisions?status=pending&limit=20&includeQuestions=true
decisions.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const statusRaw = c.req.query('status');
  const status = statusRaw && (STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as DecisionStatus)
    : undefined;
  const limitRaw = Number(c.req.query('limit'));
  // v2.27：limit 封顶 100
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  const includeQuestions = c.req.query('includeQuestions') !== 'false';
  const rows = await listDecisionCards(userId, { status, limit, includeQuestions });
  return c.json({ success: true, data: rows });
});

// GET /api/decisions/policy-digest — the bounded memory injected into prompts.
decisions.get('/policy-digest', async (c) => {
  const userId = Number(c.get('user').id);
  const digest = await buildPolicyDigest(userId);
  return c.json({
    success: true,
    data: {
      digest,
      maxChars: POLICY_DIGEST_MAX_CHARS,
      blocked: false,
      note: '反馈记忆永不覆盖硬性设置（静默时段、通知预算），这些始终由配置决定',
    },
  });
});

// GET /api/decisions/question-cap — separate from the notification budget.
decisions.get('/question-cap', async (c) => {
  const userId = Number(c.get('user').id);
  const timezone = await loadUserTimezone(userId);
  const status = await checkQuestionCardCap(userId, timezone);
  return c.json({ success: true, data: status });
});

// GET /api/decisions/:id
decisions.get('/:id', async (c) => {
  const cardId = parseCardId(c);
  if (cardId === null) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的卡片 ID' }, 400);
  }
  const userId = Number(c.get('user').id);
  const card = await getDecisionCard(userId, cardId);
  if (!card) {
    return c.json({ success: false, code: 'not_found', error: '该决定已不存在' }, 404);
  }
  return c.json({ success: true, data: card });
});

// POST /api/decisions/:id/approve — applies EXACTLY ONCE; second call -> 409.
decisions.post('/:id/approve', async (c) => {
  const cardId = parseCardId(c);
  if (cardId === null) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的卡片 ID' }, 400);
  }
  const parsed = rationaleSchema.safeParse((await readJsonBody(c)) ?? {});
  if (!parsed.success) {
    return c.json({ success: false, code: 'invalid_request', error: '请求参数无效' }, 400);
  }
  const result = await decideOnDecisionCard({
    userId: Number(c.get('user').id),
    cardId,
    action: 'approve',
    rationale: parsed.data.rationale ?? null,
    via: 'api',
  });
  return decideResponse(c, result);
});

// POST /api/decisions/:id/edit — user-adjusted payload, then approved exactly once.
decisions.post('/:id/edit', async (c) => {
  const cardId = parseCardId(c);
  if (cardId === null) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的卡片 ID' }, 400);
  }
  const parsed = editSchema.safeParse((await readJsonBody(c)) ?? {});
  if (!parsed.success) {
    return c.json({ success: false, code: 'invalid_request', error: '请求参数无效' }, 400);
  }
  const result = await decideOnDecisionCard({
    userId: Number(c.get('user').id),
    cardId,
    action: 'edit',
    rationale: parsed.data.rationale ?? null,
    payloadOverride: parsed.data.payload ?? null,
    via: 'api',
  });
  return decideResponse(c, result);
});

// POST /api/decisions/:id/reject — records the rejection + "Why?"; applies nothing.
decisions.post('/:id/reject', async (c) => {
  const cardId = parseCardId(c);
  if (cardId === null) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的卡片 ID' }, 400);
  }
  const parsed = rationaleSchema.safeParse((await readJsonBody(c)) ?? {});
  if (!parsed.success) {
    return c.json({ success: false, code: 'invalid_request', error: '请求参数无效' }, 400);
  }
  const result = await decideOnDecisionCard({
    userId: Number(c.get('user').id),
    cardId,
    action: 'reject',
    rationale: parsed.data.rationale ?? null,
    via: 'api',
  });
  return decideResponse(c, result);
});

export default decisions;
