# 通知系统使用指南

本文说明 TimeMark Vercel 版从「配置渠道」到「定时提醒」的完整流程，以及常见问题排查。

---

## 1. 端到端流程

```
设置默认邮箱 → 配置通知渠道 → 测试渠道 → 创建事件（选渠道+提前天数）→ 测试发送 → 等待 Cron 定时提醒
```

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | **设置 → 通知默认邮箱** | 全局兜底收件人，渠道测试与事件发送在未单独指定收件人时使用 |
| 2 | **通知渠道** | 按渠道填写 API Key / Webhook / Token 等；Resend 需填写 **收件人邮箱**（可留空，回退到默认邮箱） |
| 3 | **通知渠道 → 测试** | 必须返回明确成功/失败；失败会显示原因（如未配置收件人、API Key 无效） |
| 4 | **创建事件** | 选择通知渠道、提前天数、提醒时间 |
| 5 | **仪表盘 → 测试发送** | 立即发送一次，结果写入「提醒日志」 |
| 6 | **外部 Cron** | `reminder-check` 每分钟扫描到期事件并发送 |

---

## 2. 收件人解析优先级（邮件 / Resend）

发送邮件时，系统按以下顺序解析收件人：

1. 事件 `reminder_config` 中的 `emailRecipients`
2. 通知渠道账户的 **收件人邮箱**（`chat_id` 字段，须为合法邮箱）
3. **设置 → 通知默认邮箱**（`default_test_email`）
4. 用户配置中的 `reminder_emails` 列表

若以上皆无有效邮箱，发送失败并提示：**未配置收件邮箱**。

### Resend 渠道必填项

| 字段 | 必填 | 说明 |
|------|------|------|
| Resend API Key | ✅ | 在 [resend.com](https://resend.com) 获取，**不是** Vercel 环境变量 |
| 发件人邮箱 | 可选 | 已验证域名地址；留空使用 `onboarding@resend.dev`（仅测试，通常只能发给自己） |
| 收件人邮箱 | 可选* | 本渠道默认收件人；留空使用「通知默认邮箱」 |

\* 渠道与设置中至少有一处有效收件人，否则无法测试或发送。

---

## 3. 环境变量 vs 渠道配置

| 类型 | 配置位置 | 示例 |
|------|----------|------|
| **平台环境变量** | Vercel Dashboard | `DATABASE_URL`、`JWT_SECRET`、`MASTER_KEY`、`CRON_SECRET`、`SecretKey`/`SiteKey`（Turnstile） |
| **通知渠道凭证** | 应用内「通知渠道」 | Resend API Key、Telegram Bot Token、飞书 Webhook |
| **默认收件人** | 应用内「设置」 | 通知默认邮箱 |

**部署向导（设置 → 部署向导）** 仅检查平台环境变量与数据库结构版本，**不**检查 Resend 等渠道 API Key。

---

## 4. 外部 Cron（Hobby 免费必配）

Vercel Hobby 内置 Cron 仅 **每天 1 次**（`daily-maintenance`）。以下任务需通过 [cron-job.org](https://cron-job.org) 等外部服务调用，Header：`Authorization: Bearer <CRON_SECRET>`。

| 端点 | 建议频率 | 说明 |
|------|----------|------|
| `/api/cron/warmup` | 每分钟（可选） | 预热 DB 连接 |
| `/api/cron/reminder-check` | **每分钟（必须）** | 扫描并发送到期提醒 |
| `/api/cron/retry-notifications` | 每 5–15 分钟 | 重试失败的通知队列 |
| `/api/cron/calendar-sync` | 每 15 分钟 | 同步外部 ICS 日历 |
| `/api/cron/daily-maintenance` | 每天 1 次 | 可由 Vercel 内置 Cron 触发 |

---

## 5. 失败重试

发送失败会进入 `notification_queue`，按 **5 分钟 → 30 分钟 → 2 小时 → 6 小时** 退避重试（需配置 `retry-notifications` Cron）。

可在 **提醒日志** 页面查看每次触发结果；**设置 → 邮件记录** 查看近 30 天邮件发送记录。

---

## 6. 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 渠道测试显示成功但收不到邮件 | 未配置收件人且默认邮箱为空 | 填写渠道收件人或设置默认邮箱 |
| 测试按钮报「未配置收件邮箱」 | 同上 | 设置 → 通知默认邮箱，或 Resend 渠道填收件人 |
| 事件测试发送失败 | 渠道未激活、测试未通过、收件人为空 | 通知渠道页重新测试并确认绿色状态 |
| 定时提醒从不触发 | 未配置外部 `reminder-check` Cron | 部署向导中复制 URL 到 cron-job.org |
| 渠道凭证解密失败 | 更换过 `MASTER_KEY` | 重新保存各通知渠道配置 |
| 自检某行红色 | 见部署向导中文说明 | Turnstile 为可选项；Resend 不在自检范围内 |

---

## 7. 相关代码

| 模块 | 路径 |
|------|------|
| 发送调度 | `backend/src/services/notifications/index.ts` |
| 渠道定义 | `backend/src/services/notifications/channels.config.ts` |
| 连接测试 | `backend/src/services/notifications/test-connection.ts` |
| 定时任务 | `backend/src/jobs/tasks.ts` |
| 重试队列 | `backend/src/services/notification-retry.service.ts` |
| 邮件日志 | `backend/src/services/email-log.service.ts` |
