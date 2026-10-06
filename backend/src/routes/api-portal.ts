import { Hono } from 'hono';
import type { Context } from 'hono';
import { query } from '../db/index.js';
import { resolveAgentTokenCredential } from '../services/agent-tokens.service.js';
import { writeAgentAudit } from '../services/agent-tokens.service.js';
import { checkAgentRateLimit } from '../services/agent/rate-limit.service.js';
import { createEvent } from '../services/event.service.js';
import { listExpiryItems } from '../services/expiry.service.js';
import { listHabits } from '../services/habit.service.js';
import { createLogger } from '../utils/logger.js';
import { createEventSchema } from '@timemark/shared';
import type { AgentTokenScope } from '../services/agent-tokens.service.js';

/**
 * v2.30 方向 B：对外 REST API（/api/v1/*）。
 *
 * 鉴权与 MCP 同源：`Authorization: Bearer tmt_...`（agent_tokens 表），
 * 逐调用校验 credential（未撤销/未过期）+ scope（read 只读、write 才能写），
 * 逐调用限流（checkAgentRateLimit 双层窗口）并写 agent_audit_logs。
 *
 * 端点族（全部 `{ success, data|error }` 形状）：
 * - GET /v1/events?from=&to=&limit=      事件列表（日期升序）
 * - GET /v1/events/:id                   单事件
 * - GET /v1/expiry?within=&kind=&page=   到期中心
 * - GET /v1/habits                       习惯 + 连击
 * - GET /v1/stats/daily?from=&to=        stats_daily 日统计
 * - POST /v1/events                      新建事件（write scope，复用 createEventSchema）
 *
 * 安全红线：绝不回显凭据列；limit 上限 100；错误信息不含内部细节。
 */

const log = createLogger('api-portal');

const apiV1 = new Hono<{ Variables: { apiPortalAuth: PortalAuth } }>();

interface PortalAuth {
  userId: number;
  tokenId: string;
  scopes: AgentTokenScope[];
}

function bearerToken(c: Context): string | null {
  const raw = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  return raw ? raw : null;
}

function hasScope(scopes: readonly AgentTokenScope[], need: 'read' | 'write'): boolean {
  if (need === 'read') return scopes.includes('read') || scopes.includes('write') || scopes.includes('admin');
  return scopes.includes('write') || scopes.includes('admin');
}

/** 鉴权 + 限流 + 审计一次性前置。失败时直接返回 Response。 */
async function portalAuth(c: Context, need: 'read' | 'write'): Promise<PortalAuth | Response> {
  const token = bearerToken(c);
  if (!token) {
    return c.json({ success: false, error: 'missing_token' }, 401);
  }
  const credential = await resolveAgentTokenCredential(token);
  if (credential.status !== 'ok') {
    const reason = credential.status === 'revoked' ? 'token_revoked' : credential.status === 'expired' ? 'token_expired' : 'invalid_token';
    return c.json({ success: false, error: reason }, 401);
  }
  if (!hasScope(credential.scopes, need)) {
    return c.json({ success: false, error: `insufficient_scope: 需要 ${need} scope` }, 403);
  }
  const rate = await checkAgentRateLimit(`api-portal:${credential.tokenId}`, { perMinute: 120, windowMs: 60_000 });
  if (!rate.allowed) {
    return c.json(
      { success: false, error: 'rate_limited', message: '请求过于频繁，请稍后再试' },
      429,
      { 'Retry-After': String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))) },
    );
  }
  return { userId: credential.userId, tokenId: credential.tokenId, scopes: credential.scopes };
}

/** 逐调用审计（写失败仅记日志——审计缺失不应放大成数据不可用，与 MCP fail-closed 不同：REST 读多写少）。 */
async function audit(entry: {
  userId: number;
  tokenId: string;
  endpoint: string;
  status: 'ok' | 'denied' | 'error';
  durationMs: number;
  error?: string;
}): Promise<void> {
  try {
    await writeAgentAudit({
      userId: entry.userId,
      tokenId: entry.tokenId,
      tool: `rest:${entry.endpoint}`,
      args: {},
      decision: entry.status === 'denied' ? 'denied' : 'allowed',
      result: entry.status === 'error' ? 'error' : 'ok',
      durationMs: entry.durationMs,
      requestId: null,
    });
  } catch (err) {
    log.warn({ event: 'api_portal.audit_failed', err }, 'REST API audit write failed');
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseLimit(raw: string | undefined): number {
  return Math.min(Math.max(parseInt(raw || '50', 10) || 50, 1), 100);
}

// ---------------------------------------------------------------------------
// 只读端点（read scope）
// ---------------------------------------------------------------------------

apiV1.get('/events', async (c) => {
  const started = Date.now();
  const auth = await portalAuth(c, 'read');
  if (auth instanceof Response) return auth;
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = parseLimit(c.req.query('limit'));
    const params: unknown[] = [auth.userId, limit];
    // 全静态 SQL：日期过滤用占位符 + NULL 旁路，不拼接用户输入
    let sql = `SELECT id, name, type, date, calendar_type, lunar_date, person_name,
                      reminder_times, created_at
               FROM events
               WHERE user_id = $1
                 AND ($3::text IS NULL OR date >= $3::date)
                 AND ($4::text IS NULL OR date <= $4::date)
               ORDER BY date ASC
               LIMIT $2`;
    if (from && DATE_RE.test(from)) params.push(from);
    else params.push(null);
    if (to && DATE_RE.test(to)) params.push(to);
    else params.push(null);
    const result = await query(sql, params);
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/events', status: 'ok', durationMs: Date.now() - started });
    return c.json({ success: true, data: result.rows });
  } catch (error) {
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/events', status: 'error', durationMs: Date.now() - started, error: 'internal' });
    log.error({ event: 'api_portal.events_failed', err: error }, 'GET /v1/events failed');
    return c.json({ success: false, error: 'internal_error' }, 500);
  }
});

apiV1.get('/events/:id', async (c) => {
  const started = Date.now();
  const auth = await portalAuth(c, 'read');
  if (auth instanceof Response) return auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: 'invalid_id' }, 400);
  }
  const result = await query(
    `SELECT id, name, type, date, calendar_type, lunar_date, person_name,
            reminder_times, reminder_config, created_at
     FROM events WHERE id = $1 AND user_id = $2`,
    [id, auth.userId],
  );
  await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/events/:id', status: 'ok', durationMs: Date.now() - started });
  if (!result.rows[0]) {
    return c.json({ success: false, error: 'not_found' }, 404);
  }
  return c.json({ success: true, data: result.rows[0] });
});

apiV1.get('/expiry', async (c) => {
  const started = Date.now();
  const auth = await portalAuth(c, 'read');
  if (auth instanceof Response) return auth;
  try {
    const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1);
    const limit = parseLimit(c.req.query('limit'));
    const kindRaw = c.req.query('kind');
    const kind = kindRaw && ['subscription', 'bill', 'insurance', 'domain', 'warranty', 'other'].includes(kindRaw)
      ? kindRaw
      : undefined;
    const result = await listExpiryItems(auth.userId, { kind }, page, limit);
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/expiry', status: 'ok', durationMs: Date.now() - started });
    return c.json({ success: true, data: { items: result.items, total: result.total, page, limit } });
  } catch (error) {
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/expiry', status: 'error', durationMs: Date.now() - started, error: 'internal' });
    log.error({ event: 'api_portal.expiry_failed', err: error }, 'GET /v1/expiry failed');
    return c.json({ success: false, error: 'internal_error' }, 500);
  }
});

apiV1.get('/habits', async (c) => {
  const started = Date.now();
  const auth = await portalAuth(c, 'read');
  if (auth instanceof Response) return auth;
  try {
    const active = c.req.query('active');
    const habits = await listHabits(auth.userId, {
      active: active === undefined ? undefined : active === 'true',
      sort: 'name',
    });
    // 只输出公开字段（不回显内部 id 之外的列）
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/habits', status: 'ok', durationMs: Date.now() - started });
    return c.json({
      success: true,
      data: habits.map((h) => ({
        id: h.id,
        name: h.name,
        isActive: h.is_active,
        streak: h.streak?.current ?? 0,
        longestStreak: h.streak?.longest ?? 0,
        targetPerPeriod: h.target_per_period,
        period: h.period,
      })),
    });
  } catch (error) {
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/habits', status: 'error', durationMs: Date.now() - started, error: 'internal' });
    log.error({ event: 'api_portal.habits_failed', err: error }, 'GET /v1/habits failed');
    return c.json({ success: false, error: 'internal_error' }, 500);
  }
});

apiV1.get('/stats/daily', async (c) => {
  const started = Date.now();
  const auth = await portalAuth(c, 'read');
  if (auth instanceof Response) return auth;
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = parseLimit(c.req.query('limit'));
    const params: unknown[] = [auth.userId, limit];
    let sql = `SELECT day, events_count, reminders_sent, reminders_failed
               FROM stats_daily
               WHERE user_id = $1
                 AND ($3::text IS NULL OR day >= $3::date)
                 AND ($4::text IS NULL OR day <= $4::date)
               ORDER BY day DESC
               LIMIT $2`;
    if (from && DATE_RE.test(from)) params.push(from);
    else params.push(null);
    if (to && DATE_RE.test(to)) params.push(to);
    else params.push(null);
    const result = await query(sql, params);
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/stats/daily', status: 'ok', durationMs: Date.now() - started });
    return c.json({ success: true, data: result.rows });
  } catch (error) {
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'GET /v1/stats/daily', status: 'error', durationMs: Date.now() - started, error: 'internal' });
    log.error({ event: 'api_portal.stats_failed', err: error }, 'GET /v1/stats/daily failed');
    return c.json({ success: false, error: 'internal_error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// 写端点（write scope）
// ---------------------------------------------------------------------------

const portalCreateEventSchema = createEventSchema;

apiV1.post('/events', async (c) => {
  const started = Date.now();
  const auth = await portalAuth(c, 'write');
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => null);
  const parsed = portalCreateEventSchema.safeParse(body);
  if (!parsed.success) {
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'POST /v1/events', status: 'denied', durationMs: Date.now() - started, error: 'validation' });
    return c.json({ success: false, error: 'validation_failed' }, 400);
  }
  try {
    const event = await createEvent(String(auth.userId), parsed.data);
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'POST /v1/events', status: 'ok', durationMs: Date.now() - started });
    return c.json({ success: true, data: { id: event.id, name: event.name, date: event.date } }, 201);
  } catch (error) {
    await audit({ userId: auth.userId, tokenId: auth.tokenId, endpoint: 'POST /v1/events', status: 'error', durationMs: Date.now() - started, error: 'internal' });
    log.error({ event: 'api_portal.create_event_failed', err: error }, 'POST /v1/events failed');
    return c.json({ success: false, error: 'internal_error' }, 500);
  }
});

export default apiV1;
