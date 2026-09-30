# Local Agent Worker (outbound-only)

TimeMark's agent queue (the `agent_jobs` lease/ heartbeat / complete protocol) can be drained by
either the in-process server executor **or** an optional **local worker** running next to your
model. The local worker is a normal API *client*: it polls outward for work, runs a job, and posts
the result back. It opens **no inbound port**, needs **no tunnel**, and requires **no firewall
change** — every connection it makes is outbound HTTPS to your TimeMark URL (plus loopback to
Ollama).

The worker is **optional**. If you never run one, the queue behaves exactly as before.

## Endpoints (the worker contract)

All endpoints authenticate with a **dedicated worker token** (see below). Non-GET requests must
also be machine POSTs that carry `Authorization` + `X-Requested-With: XMLHttpRequest` (the app's
CSRF guard requires the marker when there is no browser `Origin`).

| Method | Path | Purpose | Body / notes |
|---|---|---|---|
| `GET`  | `/api/agent/worker/me` | Capability discovery | none. Returns protocol `version`, endpoint map, `claimModes`, `maxBatch`, lease hints. DB-free. |
| `POST` | `/api/agent/worker/drain?mode=claim` | Claim a batch of jobs | `{ "limit": n }` (optional). Returns `{ mode, protocol, reclaimed, claimed: ClaimedJob[], claimedCount, remaining }`. |
| `POST` | `/api/agent/jobs/:id/heartbeat` | Renew the lease on a running job | `{ "leaseToken": string, "extendSeconds"?: number }` → `{ renewed, leaseExpiresAt }`. |
| `POST` | `/api/agent/jobs/:id/complete` | Mark a job succeeded | `{ "leaseToken": string, "result"?: unknown, "costTokens"?: number }` → `{ completed }`. |
| `POST` | `/api/agent/jobs/:id/fail` | Record failure (retry/backoff/dead-letter) | `{ "leaseToken": string, "errorCode"?: string, "errorMessage"?: string, "retryable"?: boolean }` → `{ recorded, outcome, nextRunAt }`. |

`ClaimedJob` is
`{ id, userId, kind, payload, priority, attempt, maxAttempts, leaseToken, leaseExpiresAt }`.
**Echo `leaseToken` back verbatim** on heartbeat/complete/fail. A `200` with `renewed: false` /
`completed: false` / `recorded: false` means the lease was already gone (stale worker) — it is a
no-op, never an error. Delivery is **at-least-once**, so every job handler must be idempotent.

Without `?mode=claim`, `POST /api/agent/worker/drain` keeps its original in-process behaviour
(claims and executes server-side, returning `{ claimed, succeeded, failed, reclaimed, remaining }`).
`mode=claim` is what an external worker uses: the server claims the leases and hands them out
*without* executing, so the worker owns the run.

### Worker identity headers (optional but recommended)

| Header | Meaning |
|---|---|
| `X-Agent-Worker-Id` | Stable id for this worker (e.g. `home-nas-01`). |
| `X-Agent-Worker-Kind` | Human label (e.g. `local-ollama`). |

When present on a drain/heartbeat call, the API writes a `agent_workers` heartbeat
(`touchAgentWorker(id, kind)`), so the worker **appears in `/workers`** (`GET
/api/admin/agent/workers`) and in the `worker.workers` list of `GET /api/agent/health`, marked
online while its `last_seen_at` is fresh.

### Integrator mount

The worker router is already mounted at `/api/agent/worker` (that is how `/me` and `/drain`
resolve). The job-lifecycle router is exported as `agentJobWorkerRoutes` from
`backend/src/routes/agent-worker.ts` and must be mounted by the integrator in
`backend/src/index.ts`, **before** the `/api/agent` sub-app so its wildcard middleware cannot
shadow it:

```ts
import agentWorkerRoutes, { agentJobWorkerRoutes } from './routes/agent-worker.js';
// ...
app.route('/api/agent/worker', agentWorkerRoutes);
app.route('/api/agent/jobs', agentJobWorkerRoutes); // <-- add this line (before /api/agent)
app.route('/api/agent', agentRoutes);
```

Until that line lands, the same handlers are also reachable as an out-of-the-box alias at
`/api/agent/worker/jobs/:id/*`; set `JOBS_BASE=/api/agent/worker/jobs` in the worker to use it.

## The dedicated worker token

The worker credential is the **`AGENT_WORKER_TOKEN`** environment variable on the deployment. It
is deliberately distinct from agent *tool* tokens (`tmt_…`, managed in Settings and stored hashed
in `agent_tokens`):

- Different secret, different endpoints. A `tmt_…` token cannot call the worker endpoints, and the
  worker token is not a scoped tool grant.
- `AGENT_WORKER_TOKEN` is compared in constant time (`timingSafeEqual`) and never echoed in
  responses. It is not stored in the database; provisioning is a deployment env change only.
- `CRON_SECRET` is still accepted on the drain endpoint for the existing cron-job.org trigger
  (backwards compatible). For a local worker, use `AGENT_WORKER_TOKEN` so worker access can be
  rotated independently of cron.

Provision it by generating a long random value and setting it in **both** places:

```bash
# generate once
openssl rand -hex 32     # e.g. 9f1c...  (64 hex chars)

# deployment (Vercel Production env):
vercel env add AGENT_WORKER_TOKEN

# the worker host (same value):
export AGENT_WORKER_TOKEN=9f1c...
```

Rotate by setting a new value and restarting the worker. The old value stops working immediately.

## Reference worker

`scripts/agent-worker.mjs` is a dependency-free (Node built-ins + `fetch`) reference worker. It
runs one job at a time (a single local model), renews the lease on an interval, posts results
back, backs off exponentially on errors, and shuts down gracefully on `SIGINT`/`SIGTERM`.

```bash
TIMEMARK_URL=https://timemark.example.com \
AGENT_WORKER_TOKEN=9f1c... \
OLLAMA_URL=http://127.0.0.1:11434 \
OLLAMA_MODEL=llama3.1 \
node scripts/agent-worker.mjs

# single cycle, then exit (cron / Task Scheduler style)
node scripts/agent-worker.mjs --once
```

It interprets a job by reading a prompt from `payload.prompt` / `payload.text` / `payload.messages`
(or a bare string) and calling Ollama's `/api/generate`; the model's text is returned as the job
result. A job with no prompt is failed with code `NO_PROMPT` (retryable).

## Install as a service

The worker is a plain long-running process. Point a service manager at `node scripts/agent-worker.mjs`
with the env vars above.

### Windows — NSSM

```powershell
# https://nssm.cc/download ; put nssm.exe on PATH
nssm install TimeMarkWorker "C:\Program Files\nodejs\node.exe" "C:\timemark\scripts\agent-worker.mjs"
nssm set TimeMarkWorker AppEnvironmentExtra TIMEMARK_URL=https://timemark.example.com AGENT_WORKER_TOKEN=9f1c... OLLAMA_MODEL=llama3.1
nssm set TimeMarkWorker AppExit Default Restart
nssm set TimeMarkWorker AppStdout "C:\timemark\worker.log"
nssm set TimeMarkWorker AppStderr "C:\timemark\worker.log"
nssm start TimeMarkWorker
```

### Windows — Task Scheduler (no extra tools)

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\timemark\scripts\agent-worker.mjs" `
  -WorkingDirectory "C:\timemark"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "TimeMarkWorker" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

Set `TIMEMARK_URL` / `AGENT_WORKER_TOKEN` / `OLLAMA_*` as user or machine environment variables first
(the task inherits the environment of the account it runs as).

### Linux / NAS (systemd)

```ini
# /etc/systemd/system/timemark-agent-worker.service
[Unit]
Description=TimeMark local agent worker (outbound-only)
After=network-online.target ollama.service
Wants=network-online.target

[Service]
User=timemark
Environment=TIMEMARK_URL=https://timemark.example.com
Environment=AGENT_WORKER_TOKEN=9f1c...
Environment=OLLAMA_URL=http://127.0.0.1:11434
Environment=OLLAMA_MODEL=llama3.1
ExecStart=/usr/bin/node /opt/timemark/scripts/agent-worker.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now timemark-agent-worker
journalctl -u timemark-agent-worker -f
```

### Docker

```bash
docker run -d --name timemark-worker --restart unless-stopped \
  -e TIMEMARK_URL=https://timemark.example.com \
  -e AGENT_WORKER_TOKEN=9f1c... \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  -e OLLAMA_MODEL=llama3.1 \
  -v /opt/timemark/scripts:/app/scripts:ro \
  node:22-alpine node /app/scripts/agent-worker.mjs
```

(Use `--network host` on Linux if Ollama is bound to loopback and you prefer `127.0.0.1`.)

## No firewall change required

- The worker only makes **outbound** connections: HTTPS to `TIMEMARK_URL`, and (on the same
  machine) HTTP to `OLLAMA_URL`.
- Nothing on the internet connects **to** the worker. There is no listener, no open port, no
  reverse proxy and no tunnel.
- Consequently, no router port-forward, no inbound firewall rule, and no NAT change is needed on
  the worker host or the NAS.
