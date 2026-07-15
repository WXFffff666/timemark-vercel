# 集成功能（Webhook / 日历）

v22 起支持入站 Webhook、公开 ICS 订阅与外部日历同步；**v27** 起可选 Google OAuth 只读同步。迁移在 API 冷启动时自动执行。

可在 **设置 → 部署向导 → 系统自检** 确认数据库结构版本（当前期望 **v27**）。

---

## 1. 配置入口

**设置 → 集成**（或 **日历 → 集成 API**）

首次部署后，系统为每位用户自动生成：

- `webhook_inbound_token` — 入站 Webhook 路径令牌
- `calendar_feed_token` — 公开 ICS 订阅令牌
- `webhook_inbound_secret` — 可选 HMAC 签名校验密钥

---

## 2. 入站 Webhook（创建事件）

**URL**（在设置 → 集成中复制）：

```
POST https://你的域名/api/webhook/receive/<webhook_inbound_token>
Content-Type: application/json
```

**请求体示例**：

```json
{
  "name": "会议提醒",
  "date": "2026-07-20",
  "type": "other",
  "daysBefore": [1, 3],
  "channels": ["resend"],
  "remind": true
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` / `title` / `summary` | ✅ | 事件名称 |
| `date` / `start` | ✅ | `YYYY-MM-DD` |
| `type` | 可选 | `birthday` / `exam` / `anniversary` / `holiday` / `other` |
| `daysBefore` | 可选 | 提前提醒天数数组，默认 `[1,3,7]` |
| `channels` | 可选 | 通知渠道 ID 列表 |

**可选签名校验**：请求头 `X-Timemark-Signature: sha256=<hmac_hex>`，使用 `webhook_inbound_secret` 对原始 body 做 HMAC-SHA256。

> 入站 Webhook 路由已豁免 CSRF，无需登录 Cookie。

---

## 3. 日历 ICS 订阅（导出）

**Feed URL**（在设置 → 集成中复制）：

```
GET https://你的域名/api/calendar/feed/<calendar_feed_token>.ics
```

可添加到 Google Calendar、Outlook、Apple Calendar 作为「通过网络订阅」源。Feed 每 5 分钟缓存，包含该用户全部事件的公历日期。

---

## 4. 外部 ICS 同步（导入）

在 **设置 → 集成** 中填写最多 5 个外部 ICS URL（如 Google 日历的「秘密地址」），点击 **立即同步**，或依赖 Cron：

```
GET /api/cron/calendar-sync
Authorization: Bearer <CRON_SECRET>
```

建议每 15 分钟调用一次。同步逻辑见 `backend/src/services/calendar-sync.service.ts`。

---

## 5. 智能冲突提示

发送通知时，若同一天还有其他日程，会在消息末尾追加 **同日冲突提示**（`conflict-hint.service.ts`）。

---

## 6. 事件提醒缓存

Cron 扫描使用 PostgreSQL 表 `event_reminder_cache`（7 天窗口），减少全表查询；**非 Redis**，无需额外依赖。

---

## 6. Google 日历 OAuth 同步（可选 · C5）

**默认不启用**。不配 `GOOGLE_OAUTH_*` 环境变量时，其他集成功能不受影响。

需要时：

1. 管理员在 Vercel 配置 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`（可选 `GOOGLE_OAUTH_REDIRECT_URI`）并 redeploy
2. 用户在 **设置 → 集成** 点击「连接 Google 日历」
3. Cron `/api/cron/calendar-sync` 自动同步已连接账户的 primary 日历（只读）

完整步骤见 **[GOOGLE_CALENDAR_OAUTH.md](./GOOGLE_CALENDAR_OAUTH.md)**。

不想配 OAuth 时，可用 **外部 ICS 秘密地址**（上一节）达到类似效果。

---

## 7. 未实现（刻意不做）

| 功能 | 说明 |
|------|------|
| Microsoft OAuth 双向同步 | 当前用 ICS URL 或 Google OAuth 只读代替 |
| Redis / Upstash | 使用 PostgreSQL 缓存表 |
| 入站邮件解析 | 仅支持 HTTP Webhook JSON |
