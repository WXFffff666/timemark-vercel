# TimeMark Vercel Deployment Guide

> **免费方案**：见 [FREE_TIER_DEPLOY.md](./FREE_TIER_DEPLOY.md)（Vercel Hobby + Neon + cron-job.org，$0/月）

Deploy TimeMark to Vercel's serverless platform with Vercel Postgres and Cron Jobs. This guide covers architecture, setup, migration, and operations.

---

## 1. Architecture Overview

TimeMark runs on Vercel using a serverless architecture:

| Layer | Technology | Details |
|-------|-----------|---------|
| **Frontend** | Static files via Vercel | Vite build, output to `frontend/dist` |
| **Backend** | Hono serverless Functions | Served at `/api/*`, single Hono app exported as default in `backend/src/index.ts` |
| **Database** | Vercel Postgres (Neon) | Serverless Postgres, connection via `DATABASE_URL` |
| **Scheduler** | Vercel Cron + external cron | `vercel.json` has `daily-maintenance` only; minute-level jobs via cron-job.org |
| **Monorepo** | pnpm workspaces | 3 packages: `shared`, `frontend`, `backend` |

Key architectural differences from the Docker deployment:

- **No SQLite**: Vercel uses PostgreSQL instead of SQLite (which is used in Docker)
- **No internal scheduler**: Vercel Cron Jobs replace the Node.js Croner scheduler
- **No filesystem access**: Vercel serverless Functions are read-only; secrets come from environment variables, not `data/.env`
- **`VERCEL` env var**: The code checks `process.env.VERCEL` to skip Docker-specific logic (e.g., scheduler startup, static file serving)
- **`VERCEL_URL`**: Automatically appended to CORS origins when detected

### Verification

```
git checkout main && git pull
vercel link
vercel --prod
```

---

## 2. Prerequisites

- A **Vercel account** (sign up at [vercel.com](https://vercel.com))
- **Vercel CLI** installed globally:
  ```bash
  npm i -g vercel
  ```
- A **Git repository** connected to Vercel (GitHub, GitLab, or Bitbucket)
- A **PostgreSQL database** (Vercel Postgres or Neon, created via the Vercel Dashboard)
- **Node.js 18+** and **pnpm** installed locally for development

---

## 3. Environment Variables

Set these variables in the Vercel Dashboard under **Settings > Environment Variables**, or use `vercel env add` via the CLI.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret (64 hex chars) |
| `MASTER_KEY` | Yes | AES-256 encryption key for notification credentials (64 hex chars) |
| `CRON_SECRET` | Yes | Shared secret for external cron job authentication |
| `CORS_ORIGIN` | No | Comma-separated allowed origins (defaults to localhost) |
| `DEFAULT_ADMIN_USERNAME` | No | Initial admin username (default: `admin`) |
| `DEFAULT_ADMIN_PASSWORD` | No | Initial admin password (default: `TimeMark@2026`) |
| `TURNSTILE_SITE_KEY` / `SiteKey` | No | Cloudflare Turnstile site key (login CAPTCHA) |
| `TURNSTILE_SECRET_KEY` / `SecretKey` | No | Cloudflare Turnstile secret key |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | No | Passkey relying party (use production domain) |
| `GOOGLE_OAUTH_CLIENT_ID` | No | **可选** — Google 日历 OAuth 只读同步；不配不影响其他功能。见 [docs/GOOGLE_CALENDAR_OAUTH.md](./docs/GOOGLE_CALENDAR_OAUTH.md) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | No | 与上配套 |
| `GOOGLE_OAUTH_REDIRECT_URI` | No | 可选；默认 `{站点}/api/calendar/google-oauth/callback` |
| `NODEJS_HELPERS` | Yes (Hobby) | Set to `0` on Vercel Hobby |
| `TZ` | No | Server timezone (default: `Asia/Shanghai`) |
| `LOG_QUERIES` | No | Enable SQL query logging (default: `false`) |

**Not environment variables** (configured in-app):

- **Resend / SMTP / Telegram API keys** → Notification Channels page per account
- **Default recipient email** → Settings → Default notification email
- **Webhook inbound / calendar feed tokens** → Auto-generated on migration v22

See [docs/NOTIFICATIONS.md](./docs/NOTIFICATIONS.md) and [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md). Optional Google Calendar OAuth: [docs/GOOGLE_CALENDAR_OAUTH.md](./docs/GOOGLE_CALENDAR_OAUTH.md).

See `.env.example` for a template with descriptions and generation commands.

---

## 4. Deployment Steps

### 4.1. Login and Link

```bash
vercel login
cd timemark
vercel link
```

Follow the prompts to link your local project to the Vercel project.

### 4.2. Set Environment Variables

Set each variable in the Vercel Dashboard, or use the CLI:

```bash
vercel env add DATABASE_URL
vercel env add JWT_SECRET
vercel env add MASTER_KEY
vercel env add CRON_SECRET
vercel env add CORS_ORIGIN
vercel env add DEFAULT_ADMIN_USERNAME
vercel env add DEFAULT_ADMIN_PASSWORD
vercel env add TZ
vercel env add LOG_QUERIES
```

### 4.3. Deploy

```bash
vercel --prod
```

Vercel will:

1. Install dependencies with `pnpm install --config.blockExoticSubdeps=false`
2. Build shared, frontend, and backend with `pnpm build`
3. Deploy frontend static files from `frontend/dist`
4. Deploy the Hono app as serverless Functions at `/api/*`
5. Register the built-in cron job in `vercel.json` (`daily-maintenance` only on Hobby)

### 4.4. Verify Deployment

Once deployed, check:

- `https://<your-project>.vercel.app/api/health` returns `{ "status": "ok", "checks": { "database": true } }`
- Log in → **Settings → Deploy Wizard** → system self-check shows schema **v27**
- Frontend loads without JavaScript errors
- Configure external cron jobs (see Section 6)

### 4.5. Manual UI End-to-End Test (Cloud Platform)

After deployment, perform these manual click-through tests **as a real user**—not via API calls:

#### 4.5.1. Login Flow Test
1. Open `https://<your-project>.vercel.app` in Chrome
2. Verify the login page renders: TimeMark logo, "掌控您的每一个倒数时刻" tagline, username/password fields, login button
3. **Manually type** default credentials (`admin` / `TimeMark@2026`) character by character
4. Click "登 录" button
5. Monitor Network tab in Chrome DevTools:
   - `POST /api/auth/login` should return **200** with `{ accessToken, refreshToken }`
   - No 4xx/5xx errors in any API call
6. After login, verify you're redirected to the events dashboard

#### 4.5.2. Event Management Test
1. On the events page, verify the event list loads (existing events or empty state)
2. Click "创建事件" (Create Event) button
3. Fill in event details:
   - Event name (e.g., "妈妈的生日")
   - Event type (e.g., "生日")
   - Date / Lunar date
   - Reminder time and days before
   - Select notification channels
4. Click "保存" (Save)
5. Monitor: `POST /api/events` should return **200**
6. Verify the new event appears in the events list

#### 4.5.3. Notification Channel Test
1. Navigate to notification channels page
2. Add a test channel (e.g., a webhook URL)
3. Click "测试发送" (Test Send) to verify connectivity
4. Monitor: The test request returns success/failure with clear error messages

#### 4.5.4. SPA Routing & Auth Guard Test
1. Navigate directly to `/events`, `/config`, `/backup` — all should load without redirect
2. Open an incognito window and navigate to `/channels` — should **redirect to `/login`** (auth guard)
3. All page transitions should happen smoothly via client-side routing (no full page reloads)

#### 4.5.5. Cron Job Verification
1. Go to Vercel Dashboard > your project > Cron Jobs
2. Verify all 5 cron jobs show status "Active"
3. Check execution history — each job should have recent successful executions
4. Manually trigger a cron job if the dashboard allows, then check backend logs

#### 4.5.6. Network Monitoring Checklist

Throughout testing, keep Chrome DevTools Network tab open and verify:

| API Endpoint | Expected Status | Notes |
|-------------|:---:|-------|
| `POST /api/auth/login` | 200 | Returns JWT tokens |
| `GET /api/events` | 200 | Returns events list |
| `POST /api/events` | 200 | Creates new event |
| `GET /api/channels` | 200 | Returns channel list |
| `POST /api/channels/test` | 200/400 | Tests channel connectivity |
| `GET /api/config` | 200 | Returns user config |
| `GET /api/backup/export` | 200 | Exports backup JSON |
| `GET /health` | 200 | `{ "status": "ok" }` |
| `GET /api/cron/reminder-check` | 200/401 | 401 without CRON_SECRET, 200 with |

> **Red flags**: Any 500 error, any CORS error, any `ERR_CONNECTION_REFUSED`, or any JavaScript console error indicates a deployment issue.

---

## 5. Database Initialization

The PostgreSQL schema and admin user must be created after the first deploy.

### Option A: One-off via Vercel CLI

```bash
# Pull environment variables from Vercel
vercel env pull .env

# Run migration script
npx tsx scripts/migrate-db.ts
```

### Option B: Direct connection

```bash
DATABASE_URL="postgresql://user:password@host:5432/dbname" npx tsx scripts/migrate-db.ts
```

### What the script does

1. Connects to PostgreSQL using `DATABASE_URL` from the environment
2. Reads `shared/src/schema.pg.sql` and executes all DDL statements (idempotent)
3. Creates the default admin user (idempotent -- skips if users already exist)
4. Uses `DEFAULT_ADMIN_USERNAME` and `DEFAULT_ADMIN_PASSWORD` from the environment

The script is fully idempotent -- it is safe to run multiple times.

### Option C: Automated on first deploy (bonus)

To automate schema creation during first boot, you can add a one-time Vercel Function that runs the migration on deployment. This is not included by default but can be added as a post-deploy hook.

---

## 6. Cron Jobs

### Built-in (Vercel `vercel.json`)

| Job | Cron Expression | Route | Description |
|-----|----------------|-------|-------------|
| **Daily Maintenance** | `0 2 * * *` | `/api/cron/daily-maintenance` | Purge sessions, expired cache, old logs and notification queue |

Hobby plan allows **one cron per day** — this is the only job in `vercel.json`.

### External (cron-job.org — required for reminders)

Configure these with `Authorization: Bearer <CRON_SECRET>`:

| Job | Suggested schedule | Route | Description |
|-----|-------------------|-------|-------------|
| **Warmup** | Every minute (optional) | `/api/cron/warmup` | Reduce cold-start DB latency |
| **Reminder Check** | **Every minute (required)** | `/api/cron/reminder-check` | Check due reminders and send notifications |
| **Retry Notifications** | Every 5–15 min | `/api/cron/retry-notifications` | Retry failed `notification_queue` entries |
| **Calendar Sync** | Every 15 min | `/api/cron/calendar-sync` | Pull external ICS calendar URLs |
| **Channel Health** | Daily (optional) | `/api/cron/channel-health` | Re-test active notification accounts |

Copy exact URLs from **Settings → Deploy Wizard** in the app.

Legacy routes (`daily-email-backup`, `hourly-cleanup`, `plugin-session-cleanup`, etc.) are **not used** on the Vercel edition.

### Cron Authentication

Each cron handler validates an `Authorization: Bearer <CRON_SECRET>` header. If `CRON_SECRET` is not set or the header does not match, the request is rejected with a 403 response.

### Database migrations

Incremental migrations (currently **v27**) run automatically on serverless cold start via `runMigrations()` in `backend/src/db/migrate.ts`. Manual run:

```bash
vercel env pull .env
npx tsx scripts/migrate-db.ts
```

Verify in **Settings → Deploy Wizard** that schema version is **v27**.

---

## 7. Notification Channels (Vercel Cloud)

Vercel serverless **only supports HTTP-based channels** (Webhook URL or Bot Token). Plugin channels that require QR login, local processes, or persistent WebSocket connections are **removed from the API and UI**, not merely skipped at send time.

### Supported channels

All channels returned by `GET /api/channels/templates` are cloud-ready. Examples:

- **Webhook**: Feishu, DingTalk, WeCom, Discord, Slack, Google Chat, IRC, Synology Chat, Twitch, generic webhook
- **Token**: Telegram, Resend/SMTP email, WxPusher, Qmsg, Bark, Gotify, ServerChan, PushPlus, Matrix, LINE, Teams, ntfy, Pushover, Apprise, and more

**Resend email setup** (in-app, not env vars):

1. Settings → Default notification email (fallback recipient)
2. Notification Channels → Resend → API Key + optional sender + optional recipient
3. Test channel → create event → test send → check Trigger Logs / Email logs

See [docs/NOTIFICATIONS.md](./docs/NOTIFICATIONS.md).

Source of truth: `backend/src/services/notifications/supported-channels.ts` and `channels.config.ts` → `getSupportedChannelTemplates()`.

### Removed on cloud (not available)

| Channel ID | Name | Reason |
|-----------|------|--------|
| `wechat_personal` | WeChat Personal (Wechaty) | QR login + Puppet, no serverless session |
| `whatsapp` | WhatsApp (Baileys) | Persistent WebSocket |
| `qq_bot` | QQ Bot (OICQ) | Native bindings + QR login |
| `signal` | Signal | Local Signal CLI |
| `imessage` | iMessage (BlueBubbles) | Plugin / local relay |
| `zalo` | Zalo | Plugin session |
| `clawbot` | WeChat ClawBot | Persistent ilink connection |
| `nostr` | Nostr | Long-lived relay connections |

**Also unavailable on Vercel**: Browser **Web Push** (requires VAPID + service worker push infrastructure; removed from Settings UI).

### Server-side enforcement

- `POST /api/config/accounts` rejects unsupported `type` values
- `POST /api/channels/test` rejects unsupported channels
- Notification dispatcher uses `filterSupportedChannels()` before send
- Vercel API bundle stubs removed IM service imports via `scripts/build-vercel-api.mjs`

### Login lockout (429)

After repeated failed logins, the account is **temporarily locked** (security feature). There is **no operational unlock script or admin backdoor** — the only ways to recover are:

1. Wait until the lock period expires (linear backoff: 5 / 10 / 15 … minutes per lock tier)
2. Log in with the **correct password** after the lock expires (successful login clears the lock state)

Lock state is tracked per username across all IPs to prevent rotation attacks. Configure security alert channels in Settings to receive lockout notifications.

---

## 8. Data Migration from SQLite

If you are migrating from an existing TimeMark Docker deployment (which uses SQLite), follow these steps.

### 8.1. Export SQLite Data

```bash
# On the Docker host, stop the container to ensure data consistency
docker compose down

# Copy the SQLite database file
cp ./data/timemark.db ./data/timemark.db.export

# Convert to PostgreSQL-compatible SQL
sqlite3 ./data/timemark.db .dump > timemark-dump.sql
```

### 8.2. Convert to PostgreSQL Format

SQLite syntax differs from PostgreSQL in several ways. Create a conversion script or use a tool like `pgloader`:

```bash
# Using pgloader (install via your package manager)
pgloader ./data/timemark.db postgresql://user:password@host:5432/dbname
```

### 8.3. Manual Conversion (Alternative)

Key differences to handle when converting manually:

- Replace `INTEGER PRIMARY KEY` with `SERIAL PRIMARY KEY` or `BIGSERIAL PRIMARY KEY`
- Replace `TEXT` dates/times with `TIMESTAMP` or `TIMESTAMPTZ`
- Replace `AUTOINCREMENT` with `GENERATED BY DEFAULT AS IDENTITY`
- SQLite's `json_extract()` calls use `->>` and `->` operators in PostgreSQL
- Boolean columns: SQLite uses `0`/`1` → convert to PostgreSQL `TRUE`/`FALSE`

### 8.4. Import into PostgreSQL

After conversion, connect to the PostgreSQL database and import:

```bash
psql "$DATABASE_URL" -f converted-dump.sql
```

Or use `pg_restore` if using a custom format dump.

### 8.5. Run Migration Script

After importing data, run the migration script to ensure the schema is complete:

```bash
DATABASE_URL="postgresql://user:password@host:5432/dbname" npx tsx scripts/migrate-db.ts
```

The script is idempotent and will skip admin creation if users already exist.

### 8.6. Verify

- Log into the TimeMark web interface and verify your events and notification channels are present
- Check that cron jobs are running (Vercel Dashboard > Cron Jobs)
- Send a test notification from each configured channel

---

## 9. Local Development

For local development against a PostgreSQL database (not Docker SQLite):

```bash
# 1. Clone the repository
git clone <repo-url>
cd timemark

# 2. Install dependencies
pnpm install --config.blockExoticSubdeps=false

# 3. Build shared package (required before backend/frontend)
pnpm build:shared

# 4. Set up environment variables
cp .env.example .env
# Edit .env with your local PostgreSQL DATABASE_URL

# 5. You can also pull Vercel env vars locally
vercel env pull .env

# 6. Run migration to set up the database
DATABASE_URL="postgresql://..." npx tsx scripts/migrate-db.ts

# 7. Start development servers (two terminals)
pnpm dev:backend    # Hono API server on http://localhost:3000
pnpm dev:frontend   # Vite dev server on http://localhost:5173
```

The frontend dev server proxies `/api/*` requests to the backend. For local development, CORS is configured to accept `http://localhost:5173` and `http://localhost:3000` by default.

### Local Database Setup

You need a local PostgreSQL instance. Options:

- **Docker**: `docker run -d --name timemark-pg -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:16`
- **Native install**: Install PostgreSQL via your package manager
- **Vercel Postgres Dev**: Use `vercel env pull .env.development.local` to get the Vercel Postgres credentials

---

## 10. Rollback Plan

If the Vercel deployment fails or needs to be reverted:

### 10.1. Instant Rollback via Vercel Dashboard

1. Go to **Vercel Dashboard > Deployments**
2. Find the last working production deployment
3. Click the three-dot menu and select **Promote to Production**

This reverts the live traffic to the previous deployment instantly.

### 10.2. Git Revert

```bash
# Find the migration commit
git log --oneline -20

# Revert the migration commit
git revert <migration-commit-hash>

# Push to trigger a new deployment
git push origin main
```

### 10.3. Restore Docker Deployment (if Vercel migration is incomplete)

If you need to go back to the Docker deployment:

1. Stop the Vercel project or remove the production domain
2. Restore the Docker container from backup:

```bash
cd /opt/timemark
docker compose up -d
```

3. Restore the SQLite database (if it was replaced):

```bash
cp ./data/timemark.db.bak ./data/timemark.db
docker compose restart
```

### 10.4. Database Rollback

- **Vercel Postgres**: Use point-in-time recovery or restore from a backup snapshot
- **Docker SQLite**: Restore `data/timemark.db` from a backup file

### 10.5. Verify Rollback

After rollback, verify:

- The health endpoint returns `{ "status": "ok" }`
- Frontend loads and is functional
- Notifications are being sent correctly
- Cron jobs are running (if using the target platform's scheduler)

---

## 11. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | **Yes** | -- | PostgreSQL connection string for Vercel Postgres or Neon. Format: `postgresql://user:password@host:5432/dbname` |
| `JWT_SECRET` | **Yes** | -- | JWT HS256 signing secret. Generate: `openssl rand -hex 64`. Must be at least 32 characters. |
| `MASTER_KEY` | **Yes** | -- | AES-256 encryption key for notification channel credentials (API keys, tokens). Generate: `openssl rand -hex 64`. Changing this invalidates all stored credentials. |
| `CRON_SECRET` | **Yes** (for cron) | -- | Shared secret for authenticating Vercel Cron Job requests. Any random string. Must match what your cron handlers expect. |
| `CORS_ORIGIN` | No | `http://localhost:5173,http://localhost:3000` | Comma-separated list of allowed CORS origins. Vercel deployment URL (`https://*.vercel.app`) is automatically added. |
| `DEFAULT_ADMIN_USERNAME` | No | `admin` | Initial admin username created by `migrate-db.ts` on first run. |
| `DEFAULT_ADMIN_PASSWORD` | No | `TimeMark@2026` | Initial admin password created by `migrate-db.ts` on first run. Change after first login. |
| `TZ` | No | `Asia/Shanghai` | Server timezone for cron scheduling and log timestamps. |
| `LOG_QUERIES` | No | `false` | Set to `true` to log all SQL queries to stdout (debugging only, not for production). |

### Secret Generation Commands

```bash
# Linux / macOS / WSL
JWT_SECRET=$(openssl rand -hex 64)
MASTER_KEY=$(openssl rand -hex 64)
CRON_SECRET=$(openssl rand -hex 32)

# Windows PowerShell
$JWT_SECRET = -join ((1..64) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
$MASTER_KEY = -join ((1..64) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
$CRON_SECRET = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

### Notes

- Unlike Docker, Vercel does **not** auto-generate `JWT_SECRET` or `MASTER_KEY`. You must set them explicitly.
- `CRON_SECRET` is mandatory in Vercel because cron jobs authenticate via HTTP headers. Without it, scheduled tasks will be rejected.
- The `VERCEL` and `VERCEL_URL` environment variables are set automatically by Vercel and do not need to be configured.
- `DATABASE_URL` for Vercel Postgres can be obtained from the Vercel Dashboard under **Storage > Postgres > Quickstart**.

---

## 12. Cloud Platform Troubleshooting

### 12.1. Frontend loads but API calls fail (502/504)

**Symptom**: Frontend loads, but all `/api/*` requests return 502 or timeout.

**Cause**: The Vercel Serverless Function isn't being invoked correctly, or the function crashes on cold start.

**Fix**:
1. Check `vercel.json` has correct `rewrites` and `functions` configuration
2. Verify `api/[[route]].ts` exists at project root and exports `default handle(app)`
3. Check Vercel deployment logs for build errors
4. Verify all dependencies are installed: `hono`, `@vercel/functions`, `pg`
5. Check that `DATABASE_URL` is set in Vercel Environment Variables

### 12.2. Database connection errors

**Symptom**: `POST /api/auth/login` returns 500 with database connection error.

**Causes**:
- `DATABASE_URL` not set or incorrect in Vercel Environment Variables
- Vercel Postgres database not created or paused
- Migration script (`scripts/migrate-db.ts`) not yet run
- Network policy blocking Vercel → Neon connections

**Fix**:
1. Verify `DATABASE_URL` in Vercel Dashboard > Settings > Environment Variables
2. Create a Vercel Postgres database in the Vercel Dashboard
3. Run `npx tsx scripts/migrate-db.ts` after pulling env vars (`vercel env pull .env`)
4. Test connectivity: `psql "$DATABASE_URL" -c "SELECT 1"`

### 12.3. Cron jobs not executing

**Symptom**: No notifications are sent, backup files aren't generated.

**Causes**:
- `CRON_SECRET` not set in environment variables
- Cron job schedule doesn't match expected behavior
- Backend function throws error during cron execution

**Fix**:
1. Set `CRON_SECRET` in Vercel Environment Variables
2. Check Vercel Dashboard > Cron Jobs for execution history and error logs
3. Verify cron schedule in `vercel.json` matches desired times (UTC)
4. Test manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/cron/reminder-check`

### 12.4. CORS errors in browser

**Symptom**: Browser console shows CORS errors for API calls.

**Cause**: `CORS_ORIGIN` not set, or custom domain not included.

**Fix**:
1. Set `CORS_ORIGIN` to your deployment URL(s) in Vercel Environment Variables
2. The code automatically adds `VERCEL_URL` to allowed origins
3. For custom domains, add them explicitly: `CORS_ORIGIN=https://timemark.example.com`

### 12.5. "Auth check timeout" on frontend

**Symptom**: Frontend shows auth check errors constantly.

**Cause**: Frontend can't reach the `/api/auth/refresh` or `/api/auth/me` endpoint.

**Fix**:
1. Verify the backend function is deployed and responding
2. Check Vercel function logs for errors
3. Verify `JWT_SECRET` is set correctly
4. Clear browser cache and cookies

### 12.6. PostgreSQL Syntax Errors (pre-migration)

**Symptom**: Backend returns 500 with PostgreSQL syntax errors.

These issues have been fixed in the current codebase:
- SQL queries using `?` bind parameters → converted to `$1, $2` ✅
- `INSERT OR REPLACE` → converted to `ON CONFLICT` ✅
- `datetime('now')` → converted to `CURRENT_TIMESTAMP` ✅
- Boolean columns compared with integers → converted to `TRUE`/`FALSE` ✅

If you encounter these, ensure you're running the latest code from the repository.
