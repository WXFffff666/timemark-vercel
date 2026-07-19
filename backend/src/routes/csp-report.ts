import { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';

const cspReport = new Hono();
const reportLimit = rateLimit(30, 60 * 1000);

cspReport.post('/', reportLimit, async (c) => {
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  if (contentLength > 8192) {
    return c.body(null, 413);
  }
  // Accept CSP violation reports; do not persist untrusted payloads in detail
  return c.body(null, 204);
});

export default cspReport;
