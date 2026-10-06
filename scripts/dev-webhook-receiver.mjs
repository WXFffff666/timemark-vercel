#!/usr/bin/env node
/**
 * 全链路真发真收测试的本地 webhook 接收器。
 *
 * 用法：node scripts/dev-webhook-receiver.mjs [port=8790]
 *   POST /*            接收任意投递（generic_webhook 渠道的真实落点），200 响应
 *   GET /_received     返回已收到的投递列表（JSON），供测试断言"真的收到了"
 *   DELETE /_received  清空记录
 *
 * 仅本地测试工具，不进入生产 bundle。
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8790);
const received = [];

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && req.url === '/_received') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count: received.length, items: received }));
    return;
  }
  if (req.method === 'DELETE' && req.url === '/_received') {
    received.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    console.log(`[webhook-receiver] ${req.method} ${req.url} (${body.length} bytes) — total ${received.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, received: received.length }));
  });
});

server.listen(port, () => {
  console.log(`[webhook-receiver] listening on http://localhost:${port} — POST 投递，GET /_received 查看收件`);
});
