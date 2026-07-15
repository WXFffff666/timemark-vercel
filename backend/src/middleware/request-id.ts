import { Context, Next } from 'hono';
import { randomUUID } from 'crypto';
import { runWithRequestId } from '../utils/logger.js';

export async function requestIdMiddleware(c: Context, next: Next) {
  const requestId = c.req.header('X-Request-ID') || randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await runWithRequestId(requestId, () => next());
}
