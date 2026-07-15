# Google 日历 OAuth 同步（可选）

> **可选功能**：不配置 `GOOGLE_OAUTH_*` 环境变量时，TimeMark 的提醒、ICS 订阅、外部 ICS URL 导入、CalDAV 等均正常工作。仅当你需要从 **Google 主日历自动只读导入** 事件时，才需要按本文配置。

## 功能说明

- 在 **设置 → 集成** 完成 OAuth 授权后，系统用 `MASTER_KEY` 加密存储 refresh token
- Cron `/api/cron/calendar-sync` 会同步已连接账户的 **primary** 日历（只读，单次最多 100 条近期事件）
- 同步策略与「外部 ICS」相同：`add_only`（只增不删）或 `replace`（替换同步），由 `external_calendar_sync_strategy` 控制
- 数据库迁移 **v27** 在冷启动时自动执行（`google_oauth_*` 字段）

**替代方案（无需 OAuth）**：在 Google 日历设置中复制 **ICS 秘密地址**，粘贴到「外部 ICS 订阅 URL」即可单向导入。

---

## 1. Google Cloud 配置

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建或选择项目
3. **API 和服务 → 库** → 启用 **Google Calendar API**
4. **API 和服务 → OAuth 同意屏幕** → 配置应用（外部或内部），添加 scope：
   - `https://www.googleapis.com/auth/calendar.readonly`
5. **API 和服务 → 凭据** → **创建 OAuth 客户端 ID**
   - 应用类型：**Web 应用**
   - **已授权的重定向 URI**（与下方环境变量一致）：
     ```
     https://你的正式域名/api/calendar/google-oauth/callback
     ```
     本地开发示例：
     ```
     http://localhost:3000/api/calendar/google-oauth/callback
     ```
6. 记录 **客户端 ID** 与 **客户端密钥**

---

## 2. Vercel 环境变量（仅需要此功能时添加）

在 Vercel Dashboard → **Settings → Environment Variables** 添加：

| 变量 | 必填 | 说明 |
|------|------|------|
| `GOOGLE_OAUTH_CLIENT_ID` | ✅ | Google OAuth 客户端 ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | ✅ | 客户端密钥 |
| `GOOGLE_OAUTH_REDIRECT_URI` | 可选 | 默认 `{站点}/api/calendar/google-oauth/callback`；多域名或自定义路径时显式设置 |

添加后 **重新部署**（Redeploy）。未配置时设置页显示「未启用」，不会报错。

---

## 3. 用户侧连接

1. 确认 **设置 → 部署向导** 中数据库结构为 **v27** 或更高
2. 打开 **设置 → 集成** → **连接 Google 日历**
3. 完成 Google 授权（需 `prompt=consent` 以获取 refresh token）
4. 可选：点击 **立即同步 Google**，或依赖外部 Cron 的 `calendar-sync` 任务

断开连接会清除本地存储的 refresh token，不影响 Google 侧授权记录（可在 Google 账户安全设置中撤销）。

---

## 4. Cron

`calendar-sync` 任务会同时处理 **外部 ICS** 与 **已连接的 Google 账户**。未配置 OAuth 或未连接 Google 时，Google 部分自动跳过。

```
GET https://你的域名/api/cron/calendar-sync
Authorization: Bearer <CRON_SECRET>
```

建议每 15 分钟执行一次（与 [FREE_TIER_DEPLOY.md](../FREE_TIER_DEPLOY.md) 一致）。

---

## 5. 限制（MVP）

| 项 | 说明 |
|----|------|
| 日历范围 | 仅 `primary` 主日历 |
| 方向 | 只读导入，不向 Google 写回 |
| 数量 | 单次同步最多 100 条事件 |
| 提醒 | 导入事件默认 `reminderConfig.enabled: false`，需手动开启提醒 |

---

## 6. 故障排查

| 现象 | 处理 |
|------|------|
| 设置页显示「未启用」 | 检查 Vercel 是否已配置 `GOOGLE_OAUTH_CLIENT_ID/SECRET` 并 redeploy |
| 连接后 `no_refresh_token` | 在 Google 账户中撤销应用授权后重新连接（需 consent） |
| 同步 0 条 | 检查主日历近期是否有事件；查看后端日志 `google-calendar-sync` |
| 部署向导 schema 非 v27 | 访问站点触发冷启动迁移，或运行 `npx tsx scripts/migrate-db.ts` |

---

## 相关文档

- [INTEGRATIONS.md](./INTEGRATIONS.md) — Webhook、ICS、CalDAV 等集成总览
- [VERCEL_DEPLOYMENT.md](../VERCEL_DEPLOYMENT.md) — 部署与环境变量
- [FREE_TIER_DEPLOY.md](../FREE_TIER_DEPLOY.md) — 免费方案与外部 Cron
