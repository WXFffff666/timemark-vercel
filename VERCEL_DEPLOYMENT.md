# TimeMark Vercel Deployment Guide

Deploy TimeMark to Vercel's serverless platform with Vercel Postgres and Cron Jobs. This guide covers architecture, setup, migration, and operations.

---

## 1. Architecture Overview

TimeMark runs on Vercel using a serverless architecture:

| Layer | Technology | Details |
|-------|-----------|---------|
| **Frontend** | Static files via Vercel | Vite build, output to `frontend/dist` |
| **Backend** | Hono serverless Functions | Served at `/api/*`, single Hono app exported as default in `backend/src/index.ts` |
| **Database** | Vercel Postgres (Neon) | Serverless Postgres, connection via `DATABASE_URL` |
| **Scheduler** | Vercel Cron Jobs | 5 cron tasks defined in `vercel.json`, replaces Docker's internal Croner scheduler |
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

Set these 9 variables in the Vercel Dashboard under **Settings > Environment Variables**, or use `vercel env add` via the CLI. All values are required in Vercel (unlike Docker where they are optional):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret (64 hex chars) |
| `MASTER_KEY` | Yes | AES-256 encryption key for notification credentials (64 hex chars) |
| `CRON_SECRET` | Yes | Shared secret for cron job authentication |
| `CORS_ORIGIN` | No | Comma-separated allowed origins (defaults to localhost) |
| `DEFAULT_ADMIN_USERNAME` | No | Initial admin username (default: `admin`) |
| `DEFAULT_ADMIN_PASSWORD` | No | Initial admin password (default: `TimeMark@2026`) |
| `TZ` | No | Server timezone (default: `Asia/Shanghai`) |
| `LOG_QUERIES` | No | Enable SQL query logging (default: `false`) |

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
5. Register the 5 cron jobs defined in `vercel.json`

### 4.4. Verify Deployment

Once deployed, check:

- `https://<your-project>.vercel.app/health` returns `{ "status": "ok" }`
- Frontend loads without errors
- Cron job invocations appear in Vercel Dashboard > Cron Jobs

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

TimeMark uses 5 cron jobs defined in `vercel.json`. Each job calls a Hono route via an HTTP request authenticated with the `CRON_SECRET` header.

| Job | Cron Expression | Route | Description |
|-----|----------------|-------|-------------|
| **Reminder Check** | `* * * * *` | `/api/cron/reminder-check` | Every minute: check for due reminders and send notifications |
| **Daily Email Backup** | `0 18 * * *` | `/api/cron/daily-email-backup` | Daily at 18:00: backup email notification credentials |
| **Daily Login Backup** | `0 19 * * *` | `/api/cron/daily-login-backup` | Daily at 19:00: backup login logs |
| **Hourly Cleanup** | `0 * * * *` | `/api/cron/hourly-cleanup` | Every hour: clean expired sessions and temporary data |
| **Plugin Session Cleanup** | `30 * * * *` | `/api/cron/plugin-session-cleanup` | Every hour at :30: clean plugin sessions |

All cron functions have a maximum duration of 30 seconds (`maxDuration: 30` in `vercel.json`).

### Cron Authentication

Each cron handler validates an `Authorization: Bearer <CRON_SECRET>` header. If `CRON_SECRET` is not set or the header does not match, the request is rejected with a 403 response.

---

## 7. Incompatible Channels

The following notification channels require WebSocket connections, local filesystem access, or native binaries. They are **automatically skipped** when `process.env.VERCEL` is set and will never be triggered in the serverless environment:

| Channel ID | Channel Name | Reason |
|-----------|-------------|--------|
| `qq_bot` | QQ Bot | Requires native OICQ bindings |
| `signal` | Signal | Requires local Signal CLI |
| `wechat_personal` | WeChat Personal (Wechaty) | Requires Puppet service |
| `whatsapp` | WhatsApp | Requires WebSocket (Baileys) |
| `clawbot` | WeChat ClawBot | Requires ilink API over persistent connection |

When the notification dispatcher detects `VERCEL` in the environment, it filters these channels out of the send list and logs a message like:

```
[Notifications] Skipping incompatible channels in Vercel: qq_bot, signal, wechat_personal, whatsapp, clawbot
```

All other channels (Resend email, Telegram, Discord, Slack, Feishu, DingTalk, WeCom, etc.) work normally in Vercel.

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
