import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

export interface CaptureServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/**
 * Minimal local HTTP endpoint used to capture what the dispatcher really sends.
 * The notification services use the real axios client, so the captured
 * method/url/body are the actual outbound request (no axios mocking).
 */
export async function startCaptureServer(): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown = null;
      try {
        json = JSON.parse(body);
      } catch {
        // Non-JSON bodies (e.g. form-encoded) are kept raw.
      }
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        json,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
