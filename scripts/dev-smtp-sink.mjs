#!/usr/bin/env node
/**
 * 全链路真发真收测试的本地 SMTP 接收器（零依赖，Docker Hub 被墙时的 mailhog 替代）。
 *
 * 用法：node scripts/dev-smtp-sink.mjs [smtpPort=1025] [httpPort=1035]
 *   SMTP :1025        nodemailer 的真实投递落点（实现最小 SMTP 会话：EHLO/MAIL/RCPT/DATA/QUIT）
 *   GET :1035/_mails  返回已收到的邮件列表（JSON），供测试断言"真的收到了"
 *   DELETE :1035/_mails 清空
 *
 * 仅本地测试工具，不进入生产 bundle。
 */
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

const smtpPort = Number(process.argv[2] || 1025);
const httpPort = Number(process.argv[3] || 1035);
const mails = [];

const smtpServer = createServer((socket) => {
  let inData = false;
  let buffer = '';
  let current = null;
  socket.write('220 fullchain-smtp-sink ready\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (inData) {
        if (line === '.') {
          inData = false;
          if (current) {
            mails.push({ at: new Date().toISOString(), ...current });
            console.log(`[smtp-sink] 收到邮件 from=${current.from} to=${current.to.join(',')} (${current.data.length} bytes) — total ${mails.length}`);
          }
          current = null;
          socket.write('250 OK: queued\r\n');
        } else {
          if (current) current.data += line + '\n';
        }
        continue;
      }

      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
        socket.write('250-fullchain-smtp-sink\r\n250-8BITMIME\r\n250-SIZE 10485760\r\n250 OK\r\n');
      } else if (cmd.startsWith('MAIL FROM:')) {
        current = { from: line.slice(10).trim(), to: [], data: '' };
        socket.write('250 OK\r\n');
      } else if (cmd.startsWith('RCPT TO:')) {
        current?.to.push(line.slice(8).trim());
        socket.write('250 OK\r\n');
      } else if (cmd === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (cmd === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
      } else if (cmd.startsWith('AUTH')) {
        // nodemailer 提供密码时会尝试 AUTH LOGIN/PLAIN——一律接受
        socket.write('235 2.7.0 Accepted\r\n');
      } else if (cmd === 'RSET') {
        current = null;
        socket.write('250 OK\r\n');
      } else if (cmd === 'NOOP') {
        socket.write('250 OK\r\n');
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });
  socket.on('error', () => {});
});
smtpServer.listen(smtpPort, () => console.log(`[smtp-sink] SMTP listening on :${smtpPort}`));

const httpServer = createHttpServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  if (req.method === 'GET' && req.url === '/_mails') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({ count: mails.length, items: mails }));
  }
  if (req.method === 'DELETE' && req.url === '/_mails') {
    mails.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404).end();
});
httpServer.listen(httpPort, () => console.log(`[smtp-sink] 查询口 http://localhost:${httpPort}/_mails`));
