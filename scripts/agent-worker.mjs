#!/usr/bin/env node
/**
 * TimeMark optional LOCAL agent worker (task 129).
 *
 * Dependency-free reference implementation of the worker contract in docs/WORKER.md: it polls
 * OUT to the TimeMark API, claims one leased job at a time (single local model => one job at a
 * time), runs it against a local Ollama server, then posts the result back. It opens NO inbound
 * port, needs NO tunnel and needs NO firewall change - every connection it makes is outbound.
 *
 *   node scripts/agent-worker.mjs            # long-running poll loop
 *   node scripts/agent-worker.mjs --once     # one drain cycle, then exit (for Task Scheduler/cron)
 *
 * Required env:
 *   TIMEMARK_URL          e.g. https://timemark.example.com
 *   AGENT_WORKER_TOKEN    the dedicated worker token (distinct from agent tool tokens)
 * Optional env:
 *   AGENT_WORKER_ID       worker id shown in /workers         (default: hostname)
 *   AGENT_WORKER_KIND     worker kind shown in /workers       (default: local-ollama)
 *   OLLAMA_URL            Ollama base URL                     (default: http://127.0.0.1:11434)
 *   OLLAMA_MODEL          model name                          (default: llama3.1)
 *   POLL_INTERVAL_MS      idle poll interval                  (default: 5000)
 *   LEASE_SECONDS         lease length requested              (default: 120)
 *   HEARTBEAT_MS          lease renewal cadence               (default: 15000)
 *   MIN_BACKOFF_MS/MAX_BACKOFF_MS  error backoff bounds       (default: 1000 / 60000)
 *   REQUEST_TIMEOUT_MS    per HTTP request timeout            (default: 30000)
 *   OLLAMA_TIMEOUT_MS     per Ollama request timeout          (default: 300000)
 *   WORKER_BASE           worker endpoints prefix             (default: /api/agent/worker)
 *   JOBS_BASE             job-lifecycle prefix                (default: /api/agent/jobs)
 */

import os from 'node:os';
import process from 'node:process';

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const base = (process.env.TIMEMARK_URL ?? '').trim().replace(/\/+$/, '');
const token = (process.env.AGENT_WORKER_TOKEN ?? '').trim();

if (!base || !token) {
  console.error('[agent-worker] TIMEMARK_URL and AGENT_WORKER_TOKEN are required');
  process.exit(1);
}

const cfg = {
  base,
  token,
  workerId: (process.env.AGENT_WORKER_ID ?? '').trim() || os.hostname(),
  kind: (process.env.AGENT_WORKER_KIND ?? '').trim() || 'local-ollama',
  ollamaUrl: ((process.env.OLLAMA_URL ?? '').trim() || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  model: (process.env.OLLAMA_MODEL ?? '').trim() || 'llama3.1',
  pollIntervalMs: positiveInt(process.env.POLL_INTERVAL_MS, 5_000),
  leaseSeconds: positiveInt(process.env.LEASE_SECONDS, 120),
  heartbeatMs: positiveInt(process.env.HEARTBEAT_MS, 15_000),
  minBackoffMs: positiveInt(process.env.MIN_BACKOFF_MS, 1_000),
  maxBackoffMs: positiveInt(process.env.MAX_BACKOFF_MS, 60_000),
  requestTimeoutMs: positiveInt(process.env.REQUEST_TIMEOUT_MS, 30_000),
  ollamaTimeoutMs: positiveInt(process.env.OLLAMA_TIMEOUT_MS, 300_000),
  workerBase: (process.env.WORKER_BASE ?? '').trim() || '/api/agent/worker',
  jobsBase: (process.env.JOBS_BASE ?? '').trim() || '/api/agent/jobs',
};

const once = process.argv.includes('--once');
let stopping = false;
let inFlight = null;

function log(level, msg, extra = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, worker: cfg.workerId, msg, ...extra })}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One authenticated JSON request against TimeMark. Throws on any non-2xx. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      // Machine POSTs carry no Origin/Referer, so the app's CSRF guard needs Bearer + marker.
      'X-Requested-With': 'XMLHttpRequest',
      'X-Agent-Worker-Id': cfg.workerId,
      'X-Agent-Worker-Kind': cfg.kind,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

/** Pull a prompt out of a job payload; supports prompt/text/string/messages shapes. */
function extractPrompt(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  if (typeof payload.prompt === 'string') return payload.prompt;
  if (typeof payload.text === 'string') return payload.text;
  if (Array.isArray(payload.messages)) {
    return payload.messages
      .map((m) => {
        const role = m && typeof m.role === 'string' ? m.role : 'user';
        const content = m ? m.content : '';
        return `${role}: ${typeof content === 'string' ? content : JSON.stringify(content)}`;
      })
      .join('\n');
  }
  return null;
}

/** Run one job against local Ollama and return a result object for the queue. */
async function runWithOllama(job) {
  const prompt = extractPrompt(job.payload);
  if (!prompt) {
    const error = new Error(`job "${job.kind}" payload has no prompt/text/messages to run`);
    error.code = 'NO_PROMPT';
    throw error;
  }
  const res = await fetch(`${cfg.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt, stream: false }),
    signal: AbortSignal.timeout(cfg.ollamaTimeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return { text: typeof data.response === 'string' ? data.response : '', model: data.model ?? cfg.model };
}

/** Claim -> run (with lease renewal) -> complete/fail. At-least-once: handlers must be idempotent. */
async function processJob(job) {
  log('info', 'job claimed', { id: job.id, kind: job.kind, attempt: job.attempt });
  const timer = setInterval(() => {
    api(`${cfg.jobsBase}/${job.id}/heartbeat`, {
      method: 'POST',
      body: { leaseToken: job.leaseToken, extendSeconds: cfg.leaseSeconds },
    }).catch((err) => log('warn', 'heartbeat failed', { id: job.id, error: err.message }));
  }, cfg.heartbeatMs);

  try {
    const result = await runWithOllama(job);
    const done = await api(`${cfg.jobsBase}/${job.id}/complete`, {
      method: 'POST',
      body: { leaseToken: job.leaseToken, result },
    });
    if (done && done.completed) log('info', 'job completed', { id: job.id });
    else log('warn', 'complete rejected (lease no longer live)', { id: job.id });
  } catch (error) {
    const errorCode = error && typeof error.code === 'string' ? error.code : 'EXECUTION_FAILED';
    try {
      const failed = await api(`${cfg.jobsBase}/${job.id}/fail`, {
        method: 'POST',
        body: {
          leaseToken: job.leaseToken,
          errorCode,
          errorMessage: String((error && error.message) || error),
          retryable: true,
        },
      });
      log('warn', 'job failed', { id: job.id, code: errorCode, outcome: failed && failed.outcome });
    } catch (failError) {
      log('error', 'fail report failed; lease will expire and be reclaimed', {
        id: job.id,
        error: failError.message,
      });
    }
  } finally {
    clearInterval(timer);
  }
}

/** One poll cycle: discover capabilities once, then claim at most one job (single local model). */
async function drainOnce() {
  const drained = await api(`${cfg.workerBase}/drain?mode=claim&limit=1`, { method: 'POST', body: { limit: 1 } });
  const jobs = drained && Array.isArray(drained.claimed) ? drained.claimed : [];
  for (const job of jobs) {
    if (stopping) return jobs.length;
    inFlight = processJob(job);
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }
  return jobs.length;
}

async function main() {
  let backoff = cfg.minBackoffMs;
  let announced = false;
  log('info', 'worker starting', { base: cfg.base, kind: cfg.kind, model: cfg.model, once });

  while (!stopping) {
    try {
      if (!announced) {
        const me = await api(`${cfg.workerBase}/me`);
        announced = true;
        log('info', 'worker contract', {
          version: me && me.version,
          endpoints: me && me.endpoints,
          claimModes: me && me.queue && me.queue.claimModes,
        });
      }
      const count = await drainOnce();
      backoff = cfg.minBackoffMs;
      if (count === 0) await sleep(cfg.pollIntervalMs);
    } catch (error) {
      log('error', 'drain cycle failed; backing off', { error: error.message, backoffMs: backoff });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, cfg.maxBackoffMs);
    }
    if (once) break;
  }
  log('info', 'worker stopped');
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', 'graceful shutdown requested', { signal });
  const grace = setTimeout(() => process.exit(0), 30_000);
  grace.unref?.();
  Promise.resolve(inFlight)
    .catch(() => {})
    .then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  log('error', 'fatal', { error: String((error && error.stack) || error) });
  process.exit(1);
});
