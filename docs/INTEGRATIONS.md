# 集成功能（Webhook / 日历）

v22 起支持入站 Webhook、公开 ICS 订阅与外部日历同步；**v27** 起可选 Google OAuth 只读同步。迁移在 API 冷启动时自动执行。

可在 **设置 → 部署向导 → 系统自检** 确认数据库结构版本（当前期望 **v78**）。

可选功能总览见 **[OPTIONAL_FEATURES.md](./OPTIONAL_FEATURES.md)**（渠道、集成、Cron 均可按需启用）。

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

### SSRF 防护（v2.16.0）

拉取外部 ICS 前，服务端会校验 URL：

- 仅允许 `http` / `https`
- 禁止内网、回环、链路本地、元数据地址（如 `127.0.0.1`、`169.254.169.254`）
- 禁止非标准端口上的私有目标

不合规 URL 会被拒绝并记录日志，不会由服务器代为请求。

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

## 7. CalDAV 回写（可选，默认关闭）

把 TimeMark 的提醒 **写回你自己的 CalDAV 日历**（Radicale / Nextcloud / iCloud / 群晖等）。需要先在
**设置 → 集成 → CalDAV 订阅** 配置只读地址与用户名/密码（Basic Auth 凭据会被复用）。

**开启方式**（迁移 v47 新增，默认 `FALSE`）：

```
GET  /api/calendar/caldav-writeback            # 读取当前状态
POST /api/calendar/caldav-writeback            # { "enabled": true, "url": "https://dav.example.com/calendars/user/timemark/" }
```

| 字段 | 说明 |
|------|------|
| `enabled` | 每用户开关，**默认关闭**；关闭时不产生任何 HTTP 请求（cron 仅一次廉价 SELECT） |
| `url` | 目标日历**集合** URL（须为公网地址，经 SSRF 校验）。与只读导入地址分开配置 |

**同步内容与契约**

- 每个实体一个远端对象：`PUT {url}/{uid}.ics`，`uid` 由实体稳定派生
  （`timemark-event-<id>@timemark.app` / `timemark-expiry-<id>@timemark.app`），重复运行**只更新不重复创建**。
- 创建：`If-None-Match: *`；更新/删除：`If-Match: <上次返回的 ETag>`。
- 内容未变化（SHA-256 内容哈希一致）时**跳过**，不产生 PUT。
- 收到 `412 Precondition Failed` 时先 `GET` 重新取 ETag 并**重试一次**；仍失败则记录可操作的错误，
  **本地状态（映射表 ETag/哈希）保持不变**，下次 cron 自动重试。远端 404 视为对象已消失（重建或视为已删除）。
- 推送实体：提醒开启的事件 + 活跃的到期项（`expiry_items.is_active = TRUE`），VALARM 按 `daysBeforeList` 生成。

**循环守卫（必读）**

1. **实体级**：`reminder_config.importSource` 非空的实体（外部 ICS / Google / CalDAV 只读导入，以及本功能
   在只读同步时写入的 `caldav` 标记）**永不回写、也永不被远端删除**。
2. **用户级**：回写 URL 与任一只读导入 URL（`caldav_url` 或 `external_calendar_urls`）相同时，整个用户跳过。
   推荐把回写目标与导入日历配置为**不同的集合**。

**免费额度纪律**

无独立定时任务：回写挂在既有 `/api/cron/caldav-sync` 调用上；关闭时零请求；每次调用每用户最多
100 次写操作（`CALDAV_WRITE_BACK_MAX_OPERATIONS_PER_USER`），实体表每张最多读取 200 行
（`CALDAV_WRITE_BACK_MAX_ENTITY_ROWS`）。

**已知限制**

- 不做 CalDAV discovery / PROPFIND：必须直接给出集合 URL。
- 切换回写 URL 后，旧集合中的历史对象不会被自动清理（映射会在新集合重新创建；远端重复对象需手动删除）。

---

## 8. 未实现（刻意不做）

| 功能 | 说明 |
|------|------|
| Microsoft OAuth 双向同步 | 当前用 ICS URL 或 Google OAuth 只读代替 |
| Redis / Upstash | 使用 PostgreSQL 缓存表 |
| 入站邮件解析 | 仅支持 HTTP Webhook JSON |
