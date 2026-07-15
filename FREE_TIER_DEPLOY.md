# TimeMark 免费云端部署指南（Vercel Hobby $0）

本指南面向 **零成本** 部署：Vercel 免费套餐 + Neon 免费 PostgreSQL + cron-job.org 外部定时器。

## 为什么需要外部 Cron？

Vercel **Hobby（免费）** 内置 Cron **每天最多 1 次**，无法每分钟检查提醒。  
TimeMark 需要 **每分钟** 扫描到期事件，因此用 [cron-job.org](https://cron-job.org)（免费）代替。

提醒精度：**每分钟扫描 + ±2 分钟时间窗口**（设 09:00 会在 08:58–09:02 内触发）。

---

## 快速部署（约 15 分钟）

### 1. 准备数据库（Neon 免费）

1. 打开 [neon.tech](https://neon.tech) 注册
2. 创建项目，复制 `DATABASE_URL`（带 `-pooler` 的连接串优先）

### 2. 部署到 Vercel

```bash
cd timemark-vercel
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
| `CRON_SECRET` | ✅ | 任意随机字符串 |
| `NODEJS_HELPERS` | ✅ | 设为 `0` |
| `CORS_ORIGIN` | 建议 | `https://你的项目.vercel.app` |
| `TZ` | 可选 | `Asia/Shanghai` |

### 4. 初始化数据库

```bash
vercel env pull .env
npx tsx scripts/migrate-db.ts
```

默认账号：`admin` / `TimeMark@2026`（首次登录会提示改密码）

### 5. 配置外部 Cron（关键！）

1. 注册 [cron-job.org](https://console.cron-job.org)
2. 创建 Cron Job：
   - **URL**: `https://你的项目.vercel.app/api/cron/reminder-check`
   - **Schedule**: `* * * * *`（每分钟）
   - **Request method**: GET
   - **Headers**: `Authorization: Bearer 你的CRON_SECRET`
3. 保存并启用

### 6. 配置通知渠道

登录 → **通知渠道** → 添加飞书/钉钉/Telegram/Bark/邮件等 **Webhook 或 Token 渠道** → 测试发送

**云端不支持**：微信个人号、WhatsApp、QQ Bot、Signal、iMessage、Zalo、Clawbot、Nostr、浏览器 Web Push。界面中不会显示这些选项。

### 7. 创建事件并验证

创建一条「今天、当前时间 ±2 分钟内」的测试事件，等待 1–2 分钟，检查 **触发日志** 页面。

---

## 健康检查

- `GET https://你的项目.vercel.app/api/health` → `{ "status": "ok" }`
- 手动测试 Cron：
  ```bash
  curl -H "Authorization: Bearer 你的CRON_SECRET" \
    https://你的项目.vercel.app/api/cron/reminder-check
  ```

---

## 祝福语说明（无需 AI API Key）

TimeMark 使用 **本地预设祝福语库**（`shared/src/blessings.ts`），根据事件类型和关系智能匹配，**不需要** OpenAI 或其他在线 API，也不会上传你的密钥。

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
| 登录 429 | 登录失败次数过多被锁定；**无运维解锁**，仅等待锁定期结束或使用正确密码登录 |
| 无微信/WhatsApp 渠道 | 云端版已移除插件类渠道，请使用飞书/钉钉/Server酱/Bark 等 HTTP 渠道 |
| 无通知 | 确认 cron-job.org 已启用且 Header 正确 |
| API 502 | 检查 `DATABASE_URL` 和 `NODEJS_HELPERS=0` |
| 深链 404 | 已配置 SPA rewrite，重新部署 |

完整文档见 [VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md)。
