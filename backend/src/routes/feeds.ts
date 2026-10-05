import { Hono, type Context } from 'hono';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createLogger } from '../utils/logger.js';
import {
  FeedIngestError,
  acceptProposal,
  createFeedSource,
  deleteFeedSource,
  ingestRawMail,
  listFeedSources,
  listProposals,
  rejectProposal,
  statusForFeedError,
  syncIcsSource,
  updateFeedSource,
  type FeedProposalStatus,
  type FeedSourceKind,
} from '../services/agent/feed-ingest.service.js';

/**
 * Task 144 — external mail + ICS feeds as event sources.
 *
 * Default Hono router mounted by the integrator at `/api/feeds`. Every route is
 * session-authenticated. Nothing here writes events/contacts directly: untrusted
 * sources only ever queue proposals; the user accepts or rejects them.
 */
const feeds = new Hono<{ Variables: { user: User } }>();
feeds.use('*', authMiddleware);
const log = createLogger('feeds');

const MAX_MAIL_BODY_BYTES = 256 * 1024;
const MIN_POLL_MINUTES = 15;
const MAX_POLL_MINUTES = 10080; // one week

async function readCappedBody(c: Context, limit: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = c.req.header('content-length');
  if (declared && Number(declared) > limit) return { ok: false };
  const body = c.req.raw.body;
  if (!body) {
    const text = await c.req.text();
    return Buffer.byteLength(text, 'utf8') > limit ? { ok: false } : { ok: true, text };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8') };
}

function parseKind(value: unknown): FeedSourceKind | null {
  return value === 'ics' || value === 'mail' ? value : null;
}

function parseHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/^webcal:\/\//i, 'https://').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function clampPoll(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 360;
  return Math.min(Math.max(Math.round(parsed), MIN_POLL_MINUTES), MAX_POLL_MINUTES);
}

function ingestFailure(c: Context, error: unknown) {
  if (error instanceof FeedIngestError) {
    return c.json({ success: false, code: error.code, error: error.message }, statusForFeedError(error.code));
  }
  log.error({ event: 'feeds.unhandled', err: error }, 'Unhandled feed error');
  return c.json({ success: false, error: '订阅源操作失败' }, 500);
}

// ---------------------------------------------------------------------------
// Sources CRUD
// ---------------------------------------------------------------------------

feeds.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const sources = await listFeedSources(userId);
  return c.json({ success: true, data: sources });
});

feeds.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = parseKind(body.kind);
  if (!kind) return c.json({ success: false, error: 'kind 必须是 ics 或 mail' }, 400);
  const name = String(body.name ?? (kind === 'ics' ? '外部日历' : '入站邮件')).trim().slice(0, 120);

  let url: string | null = null;
  if (kind === 'ics') {
    url = parseHttpUrl(body.url);
    if (!url) return c.json({ success: false, error: 'ICS 订阅需要合法的 http(s) URL' }, 400);
  }
  const mailAddress = kind === 'mail' && typeof body.mailAddress === 'string' ? body.mailAddress.trim().slice(0, 320) : null;

  try {
    const source = await createFeedSource(userId, {
      kind,
      name,
      url,
      pollIntervalMinutes: clampPoll(body.pollIntervalMinutes),
      mailAddress,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      trusted: body.trusted === undefined ? false : Boolean(body.trusted),
    });
    return c.json({ success: true, data: source }, 201);
  } catch (error) {
    return ingestFailure(c, error);
  }
});

feeds.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: '无效的订阅源 ID' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  let url: string | null | undefined;
  if (body.url !== undefined) {
    url = parseHttpUrl(body.url);
    if (!url) return c.json({ success: false, error: 'URL 必须是合法的 http(s) 地址' }, 400);
  }
  const updated = await updateFeedSource(userId, id, {
    ...(typeof body.name === 'string' ? { name: body.name.trim().slice(0, 120) } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(body.pollIntervalMinutes !== undefined ? { pollIntervalMinutes: clampPoll(body.pollIntervalMinutes) } : {}),
    ...(typeof body.mailAddress === 'string' ? { mailAddress: body.mailAddress.trim().slice(0, 320) } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(body.trusted !== undefined ? { trusted: Boolean(body.trusted) } : {}),
  });
  if (!updated) return c.json({ success: false, error: '订阅源不存在' }, 404);
  return c.json({ success: true, data: updated });
});

feeds.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: '无效的订阅源 ID' }, 400);
  const removed = await deleteFeedSource(userId, id);
  if (!removed) return c.json({ success: false, error: '订阅源不存在' }, 404);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// On-demand ICS poll
// ---------------------------------------------------------------------------

feeds.post('/:id/sync', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: '无效的订阅源 ID' }, 400);
  try {
    const result = await syncIcsSource(userId, id);
    return c.json({ success: true, data: result });
  } catch (error) {
    return ingestFailure(c, error);
  }
});

// ---------------------------------------------------------------------------
// Inbound mail ingest (RFC822)
// ---------------------------------------------------------------------------

feeds.post('/mail/inbound', async (c) => {
  const userId = Number(c.get('user').id);
  const read = await readCappedBody(c, MAX_MAIL_BODY_BYTES);
  if (!read.ok) {
    return c.json({ success: false, error: `邮件体过大（上限 ${MAX_MAIL_BODY_BYTES} 字节）` }, 413);
  }

  // Accept either a raw RFC822 body (text/plain) or JSON `{ raw, sourceId?, trusted? }`.
  let raw = read.text;
  let sourceId: number | undefined;
  let trusted: boolean | undefined;
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(read.text) as Record<string, unknown>;
      raw = typeof parsed.raw === 'string' ? parsed.raw : '';
      if (parsed.sourceId !== undefined) {
        const parsedId = Number(parsed.sourceId);
        if (Number.isInteger(parsedId)) sourceId = parsedId;
      }
      if (parsed.trusted !== undefined) trusted = Boolean(parsed.trusted);
    } catch {
      return c.json({ success: false, error: 'JSON 解析失败' }, 400);
    }
  }
  if (!raw.trim()) return c.json({ success: false, error: '缺少邮件内容' }, 400);

  try {
    const result = await ingestRawMail(userId, raw, {
      ...(sourceId !== undefined ? { sourceId } : {}),
      ...(trusted !== undefined ? { trusted } : {}),
    });
    return c.json({ success: true, data: result });
  } catch (error) {
    return ingestFailure(c, error);
  }
});

// ---------------------------------------------------------------------------
// Proposal review queue
// ---------------------------------------------------------------------------

feeds.get('/proposals', async (c) => {
  const userId = Number(c.get('user').id);
  const statusParam = c.req.query('status');
  const status: FeedProposalStatus | undefined =
    statusParam === 'pending' || statusParam === 'accepted' || statusParam === 'rejected' ? statusParam : undefined;
  // v2.27：limit 封顶 200
  const limit = Number(c.req.query('limit') ?? '50');
  const proposals = await listProposals(userId, {
    ...(status ? { status } : {}),
    limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
  });
  return c.json({ success: true, data: proposals, pagination: { total: proposals.length, limit: Math.min(Number.isInteger(limit) ? limit : 50, 200) } });
});

feeds.post('/proposals/:id/accept', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: '无效的提议 ID' }, 400);
  try {
    const decision = await acceptProposal(userId, id);
    if (!decision.ok) {
      const status = decision.reason === 'not_found' ? 404 : 409;
      return c.json({ success: false, code: decision.reason, error: decision.reason === 'not_found' ? '提议不存在' : '该提议已处理' }, status);
    }
    return c.json({ success: true, data: { applied: decision.applied } });
  } catch (error) {
    return ingestFailure(c, error);
  }
});

feeds.post('/proposals/:id/reject', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: '无效的提议 ID' }, 400);
  const decision = await rejectProposal(userId, id);
  if (!decision.ok) {
    const status = decision.reason === 'not_found' ? 404 : 409;
    return c.json({ success: false, code: decision.reason, error: decision.reason === 'not_found' ? '提议不存在' : '该提议已处理' }, status);
  }
  return c.json({ success: true });
});

export default feeds;
