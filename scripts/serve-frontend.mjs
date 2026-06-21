import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', 'frontend', 'dist');
const port = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath.startsWith('/api/')) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Backend not available', code: 'NO_BACKEND' }));
        return;
      }
      fs.readFile(path.join(root, 'index.html'), (_, idx) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, '0.0.0.0', () => console.log(`Frontend: http://localhost:${port}`));
