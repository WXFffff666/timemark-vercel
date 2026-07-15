# TimeMark 免费云端部署指南（Vercel Hobby $0）

本指南面向 **零成本** 部署：Vercel 免费套餐 + Neon 免费 PostgreSQL + cron-job.org 外部定时器。

## 为什么需要外部 Cron？

Vercel **Hobby（免费）** 内置 Cron **每天最多 1 次**（`vercel.json` 仅配置 `daily-maintenance`）。  
TimeMark 需要 **每分钟** 扫描到期事件，因此用 [cron-job.org](https://cron-job.org)（免费）调用 `/api/cron/reminder-check` 等端点。

> **装包提示**：本地 `pnpm install` / `pnpm add` 请加 `--config.blockExoticSubdeps=false`，或运行 `pnpm run install:deps`（原因见 README「本地开发与装包」）。

提醒精度：**每分钟扫描 + ±2 分钟时间窗口**（设 09:00 会在 08:58–09:02 内触发）。

---

## 快速部署（约 15 分钟）

### 1. 准备数据库（Neon 免费）

1. 打开 [neon.tech](https://neon.tech) 注册
2. 创建项目，复制 `DATABASE_URL`（带 `-pooler` 的连接串优先）

### 2. 部署到 Vercel

```bash
cd timemark-vercel
pnpm run install:deps
vercel login
vercel link
vercel --prod
```

### 3. 配置环境变量（Vercel Dashboard → Settings → Environment Variables）

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_URL` | ✅ | Neon PostgreSQL 连接串 |
| `JWT_SECRET` | ✅ | `openssl rand -hex 64` |
| `MASTER_KEY` | ✅ | `openssl rand -hex 64` |
| `CRON_SECRET` | ✅ | 任意随机字符串（外部 Cron 认证用） |
| `NODEJS_HELPERS` | ✅ | 设为 `0` |
| `CORS_ORIGIN` | 建议 | `https://你的正式域名` |
| `SecretKey` / `SiteKey` | 可选 | Cloudflare Turnstile（也支持 `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY`） |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | 建议 | 与正式域名一致（Passkey） |
| `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` | 可选 | Google 日历 OAuth 只读同步；不配不影响其他功能 → [docs/GOOGLE_CALENDAR_OAUTH.md](docs/GOOGLE_CALENDAR_OAUTH.md) |
| `TZ` | 可选 | `Asia/Shanghai` |

> **Resend API Key 不在此列表** — 在应用内「通知渠道」按账户配置。详见 [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)。

### 4. 数据库迁移

**自动**：首次访问 API 时执行 v1–v27 增量迁移。  
**手动**（可选）：

```bash
vercel env pull .env
npx tsx scripts/migrate-db.ts
```

登录后打开 **设置 → 部署向导**，确认「数据库结构版本」为 **v27**。

默认账号：`admin` / `TimeMark@2026`（首次登录会提示改密码）

### 5. 配置外部 Cron（关键！）

在 [cron-job.org](https://console.cron-job.org) 为以下端点创建任务，Header 均为：

```
Authorization: Bearer 你的CRON_SECRET
```

| 端点 | Schedule | 说明 |
|------|----------|------|
| `/api/cron/reminder-check` | `* * * * *` | **必须** — 每分钟检查提醒 |
| `/api/cron/retry-notifications` | `*/10 * * * *` | 建议 — 重试失败通知 |
| `/api/cron/calendar-sync` | `*/15 * * * *` | 可选 — 外部 ICS + Google OAuth（已连接时）同步 |
| `/api/cron/warmup` | `* * * * *` | 可选 — 减少冷启动延迟 |

完整 URL 示例：`https://你的域名/api/cron/reminder-check`

应用内 **设置 → 部署向导** 可复制各端点 URL 与 curl 示例。

### 6. 配置通知（Resend 邮件示例）

1. **设置 → 通知默认邮箱** — 填写你的收件邮箱  
2. **通知渠道 → 添加 Resend**：
   - Resend API Key（`re_...`）
   - 发件人（可选；留空用测试地址 `onboarding@resend.dev`）
   - 收件人（可选；留空用默认邮箱）
3. 点击 **测试** — 应显示成功或具体错误（不会假成功）

### 7. 创建事件并验证

1. 创建事件，选择 Resend 渠道与提前天数  
2. 仪表盘 **测试发送**  
3. 查看 **提醒日志**、**设置 → 邮件记录**  
4. 等待 1–2 分钟验证定时 Cron（事件时间设在当前 ±2 分钟内）

---

## 系统自检

**设置 → 部署向导 → 系统自检** 检查：

- 数据库连接、结构版本（v22）
- `JWT_SECRET`、`MASTER_KEY`、`CRON_SECRET`
- Turnstile（可选）

红色项为平台环境变量问题；**Resend 不在自检范围内**。

---

## 健康检查

- `GET https://你的域名/api/health` → `{ "status": "ok", "checks": { "database": true, ... } }`
- 手动测试 Cron：
  ```bash
  curl -H "Authorization: Bearer 你的CRON_SECRET" \
    https://你的域名/api/cron/reminder-check
  ```

---

## 祝福语说明（无需 AI API Key）

TimeMark 使用 **本地预设祝福语库**（`shared/src/blessings.ts`），根据事件类型和关系智能匹配，**不需要** OpenAI 或其他在线 API，也不会上传你的密钥。

---

## 集成功能

Webhook 入站、ICS 订阅、外部日历同步见 [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)。

---

## 从 Docker 版迁移数据

```bash
# 1. 导出 SQLite
cp ./data/timemark.db ./timemark.db.export

# 2. 使用 pgloader 导入 Neon（需安装 pgloader）
pgloader sqlite:///timemark.db.export "$DATABASE_URL"

# 3. 补跑迁移
npx tsx scripts/migrate-db.ts
```

**注意**：若 `MASTER_KEY` 与 Docker 版不同，需重新配置通知渠道凭证。

---

## 故障排查

| 问题 | 解决 |
|------|------|
| 登录 403 | 检查 `CORS_ORIGIN` 是否包含你的域名 |
| 登录 429 | 登录失败次数过多被锁定；等待锁定期结束或使用正确密码 |
| Resend 测试失败 | 填写 API Key + 收件人（或设置默认邮箱）；见 [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) |
| 自检缺 API | 多为 Turnstile/Cron，非 Resend；Resend 在通知渠道页配置 |
| 无通知 | 确认 cron-job.org 已启用 `reminder-check` 且 Header 正确 |
| 数据库版本低 | 重新部署或访问站点触发冷启动迁移 |
| API 502 | 检查 `DATABASE_URL` 和 `NODEJS_HELPERS=0` |
| 深链 404 | 已配置 SPA rewrite，重新部署 |

完整文档见 [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)。
