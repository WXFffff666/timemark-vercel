import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal in-process CalDAV collection used by the checkbox-86 write-back tests.
 * It enforces the real precondition semantics strictly:
 *   PUT  If-None-Match: *  -> 201 create / 412 exists
 *   PUT  If-Match: <etag>  -> 200 update / 412 mismatch
 *   PUT  (no precondition) -> 428 Precondition Required
 *   DELETE If-Match        -> 204 / 412 mismatch / 404 missing
 *   DELETE (no If-Match)   -> 428
 */

export interface RemoteCalDavObject {
  body: string;
  etag: string;
  version: number;
}

export interface RecordedCalDavRequest {
  method: string;
  uid: string;
  ifNoneMatch: string | null;
  ifMatch: string | null;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

export class MockCalDavServer {
  readonly objects = new Map<string, RemoteCalDavObject>();
  requests: RecordedCalDavRequest[] = [];
  failAll = false;
  /** PUTs for these UIDs always answer 412 (simulates a permanently rejecting server). */
  alwaysRejectPut = new Set<string>();
  /** DELETEs for these UIDs always answer 412. */
  alwaysRejectDelete = new Set<string>();

  private readonly server: Server;
  private nextVersion = 1;
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}/calendar/`;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  seed(uid: string, body = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'): string {
    const etag = this.makeEtag();
    this.objects.set(uid, { body, etag, version: this.nextVersion });
    return etag;
  }

  requestsFor(uid: string): RecordedCalDavRequest[] {
    return this.requests.filter((entry) => entry.uid === uid);
  }

  private makeEtag(): string {
    this.nextVersion += 1;
    return `"v${this.nextVersion}"`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      const lastSegment = rawPath.split('/').pop() ?? '';
      const uid = decodeURIComponent(lastSegment.replace(/\.ics$/i, ''));
      const method = (req.method ?? 'GET').toUpperCase();
      this.requests.push({
        method,
        uid,
        ifNoneMatch: headerValue(req, 'if-none-match'),
        ifMatch: headerValue(req, 'if-match'),
        authorization: headerValue(req, 'authorization'),
        contentType: headerValue(req, 'content-type'),
        body,
      });

      if (this.failAll) {
        respond(res, 500, { 'Content-Type': 'text/plain' }, 'server error');
        return;
      }

      const existing = this.objects.get(uid);
      if (method === 'GET') {
        if (!existing) respond(res, 404, {});
        else respond(res, 200, { ETag: existing.etag, 'Content-Type': 'text/calendar' }, existing.body);
        return;
      }

      if (method === 'DELETE') {
        if (this.alwaysRejectDelete.has(uid)) {
          respond(res, 412, {});
          return;
        }
        if (!existing) {
          respond(res, 404, {});
          return;
        }
        const ifMatch = headerValue(req, 'if-match');
        if (!ifMatch) {
          respond(res, 428, {});
          return;
        }
        if (ifMatch !== existing.etag) {
          respond(res, 412, {});
          return;
        }
        this.objects.delete(uid);
        respond(res, 204, {});
        return;
      }

      if (method === 'PUT') {
        if (this.alwaysRejectPut.has(uid)) {
          respond(res, 412, {});
          return;
        }
        const ifNoneMatch = headerValue(req, 'if-none-match');
        const ifMatch = headerValue(req, 'if-match');
        if (ifNoneMatch === '*') {
          if (existing) {
            respond(res, 412, {});
            return;
          }
          const etag = this.makeEtag();
          this.objects.set(uid, { body, etag, version: this.nextVersion });
          respond(res, 201, { ETag: etag, 'Content-Type': 'text/calendar' });
          return;
        }
        if (ifMatch) {
          if (!existing || ifMatch !== existing.etag) {
            respond(res, 412, {});
            return;
          }
          const etag = this.makeEtag();
          this.objects.set(uid, { body, etag, version: this.nextVersion });
          respond(res, 200, { ETag: etag, 'Content-Type': 'text/calendar' });
          return;
        }
        respond(res, 428, {});
        return;
      }

      respond(res, 405, {});
    });
  }
}

export function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw[0] ?? null;
  return null;
}

export function respond(res: ServerResponse, status: number, headers: Record<string, string>, body?: string): void {
  res.writeHead(status, headers);
  if (body === undefined) res.end();
  else res.end(body);
}
