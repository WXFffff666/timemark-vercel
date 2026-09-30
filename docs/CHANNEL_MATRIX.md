# 通知渠道矩阵（CHANNEL_MATRIX）

> ⚠️ 本文件由 `scripts/gen-channel-matrix.mjs` 自动生成，请勿手工修改。
> 唯一数据源：`backend/src/services/notifications/channels.config.ts`（`getSupportedChannelTemplates()`）。
> 连接测试列由 `test-connection.ts` 的真实分支解析得到；官方地址优先取模板 `officialUrl`，缺省回退 `docsUrl`。

**云端可用渠道：42 个**（webhook 11 · token 31）· **Serverless 不可用：8 个** · **当前 schema：v75**

## 1. 云端渠道总表（42）

| # | ID | 名称 | configMethod | 必填字段 → DB 列 | 真实连接测试 | 官方地址 |
|---|----|------|--------------|------------------|--------------|----------|
| 1 | `discord` | Discord / Discord | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://discord.com/developers/applications> |
| 2 | `slack` | Slack / Slack | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://api.slack.com/messaging/webhooks> |
| 3 | `feishu` | 飞书 (Feishu) / Feishu | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN> |
| 4 | `wecom` | 企业微信 (WeCom) / WeCom | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://developer.work.weixin.qq.com/document/path/91770> |
| 5 | `dingtalk` | 钉钉 (DingTalk) / DingTalk | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://open.dingtalk.com/document/robot/customize-bot-notification> |
| 6 | `googlechat` | Google Chat / Google Chat | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://developers.google.com/chat> |
| 7 | `irc` | IRC / IRC | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://github.com/42wim/matterbridge/wiki> |
| 8 | `synologychat` | Synology Chat / Synology Chat | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://kb.synology.com/en-global/DSM/help/Chat/chat_integration> |
| 9 | `twitch` | Twitch / Twitch | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://dev.twitch.tv/docs/eventsub/> |
| 10 | `generic_webhook` | 自定义 Webhook | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://developer.mozilla.org/en-US/docs/Web/API/Webhooks> |
| 11 | `rocketchat` | Rocket.Chat | `webhook` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testWebhookChannel` | <https://docs.rocket.chat/docs/integrations> |
| 12 | `resend` | Resend / Resend | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://resend.com/docs> |
| 13 | `smtp` | SMTP 邮件 / SMTP Email | `token` | `chat_id` → `chat_id`、`token` → `token`、`webhook` → `webhook`、`secret` → `secret` | ✅ `test-connection.ts` → `testTokenChannel` | <https://nodemailer.com/about/> |
| 14 | `telegram` | Telegram / Telegram | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://core.telegram.org/bots> |
| 15 | `line` | LINE / LINE | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://developers.line.biz/> |
| 16 | `matrix` | Matrix / Matrix | `token` | `homeserver` → `webhook`、`token` → `token`、`roomId` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://matrix.org/> |
| 17 | `mattermost` | Mattermost / Mattermost | `token` | `webhook` → `webhook`、`token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://docs.mattermost.com/guides/mattermost-operator-guide.html> |
| 18 | `msteams` | Microsoft Teams / Microsoft Teams | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://learn.microsoft.com/en-us/microsoftteams/platform/> |
| 19 | `nextcloud_talk` | Nextcloud Talk | `token` | `webhook` → `webhook`、`token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://nextcloud-talk.readthedocs.io/en/latest/> |
| 20 | `wxpusher` | WxPusher / WeChat Push (WxPusher) | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://wxpusher.zjiecode.com/> |
| 21 | `qmsg` | Qmsg / Qmsg QQ | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://qmsg.zendee.cn/> |
| 22 | `serverchan` | Server酱 (ServerChan) | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://sct.ftqq.com/> |
| 23 | `pushplus` | PushPlus | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://www.pushplus.plus/doc/> |
| 24 | `bark` | Bark | `token` | `webhook` → `webhook`、`token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://bark.day.app/> |
| 25 | `gotify` | Gotify | `token` | `webhook` → `webhook`、`token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://gotify.net/docs/> |
| 26 | `meow` | 喵推送 (Meow) | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://meopush.com/> |
| 27 | `pushme` | PushMe | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://push.i-i.me/> |
| 28 | `pushdeer` | PushDeer | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://www.pushdeer.com/> |
| 29 | `twilio` | Twilio SMS | `token` | `token` → `token`、`secret` → `secret`、`webhook` → `webhook`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://www.twilio.com/docs/sms> |
| 30 | `wecomapp` | 企微应用 (WeComApp) | `token` | `token` → `token`、`secret` → `secret`、`chat_id` → `chat_id`、`webhook` → `webhook` | ✅ `test-connection.ts` → `testTokenChannel` | <https://developer.work.weixin.qq.com/document/path/90236> |
| 31 | `ntfy` | Ntfy | `token` | `webhook` → `webhook`、`token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://docs.ntfy.sh/> |
| 32 | `pushover` | Pushover | `token` | `token` → `token`、`secret` → `secret` | ✅ `test-connection.ts` → `testTokenChannel` | <https://pushover.net/api> |
| 33 | `apprise` | Apprise | `token` | `webhook` → `webhook` | ✅ `test-connection.ts` → `testTokenChannel` | <https://github.com/caronc/apprise-api> |
| 34 | `serverchan3` | Server酱³ (SC3) | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://sct.ftqq.com/compare/> |
| 35 | `xizhi` | 息知 (XiZhi) | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://xz.qqoq.net/> |
| 36 | `anpush` | AnPush | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://anpush.com/> |
| 37 | `chanify` | Chanify | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://github.com/chanify/chanify-ios> |
| 38 | `pushback` | Pushback | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://pushback.io/docs/getting-started> |
| 39 | `simplepush` | SimplePush | `token` | `token` → `token` | ✅ `test-connection.ts` → `testTokenChannel` | <https://simplepush.io/> |
| 40 | `zulip` | Zulip | `token` | `webhook` → `webhook`、`token` → `token`、`chat_id` → `chat_id`、`secret` → `secret` | ✅ `test-connection.ts` → `testTokenChannel` | <https://zulip.com/api/send-message> |
| 41 | `fcm` | Firebase 推送 (FCM) | `token` | `token` → `token`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://firebase.google.com/docs/cloud-messaging/send/v1-api> |
| 42 | `twilio_whatsapp` | Twilio WhatsApp | `token` | `token` → `token`、`secret` → `secret`、`webhook` → `webhook`、`chat_id` → `chat_id` | ✅ `test-connection.ts` → `testTokenChannel` | <https://www.twilio.com/docs/whatsapp/api> |

## 2. 字段 → notification_accounts 列（含可选字段，共 88 项）

| 渠道 | 字段 | → DB 列 | 必填 | 标签 | 英文标签 |
|------|------|---------|------|------|----------|
| `discord` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `slack` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `feishu` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `wecom` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `dingtalk` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `dingtalk` | `secret` | `secret` | 否 | 加签密钥 (可选) | Signing Secret |
| `googlechat` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `irc` | `webhook` | `webhook` | 是 | Webhook URL | Bridge Webhook URL |
| `synologychat` | `webhook` | `webhook` | 是 | Webhook URL | Webhook URL |
| `twitch` | `webhook` | `webhook` | 是 | Webhook URL | EventSub Webhook URL |
| `generic_webhook` | `webhook` | `webhook` | 是 | Webhook URL | — |
| `generic_webhook` | `secret` | `secret` | 否 | Secret Key (可选) | — |
| `rocketchat` | `webhook` | `webhook` | 是 | Webhook URL | — |
| `resend` | `token` | `token` | 是 | Resend API Key | Resend API Key |
| `resend` | `webhook` | `webhook` | 否 | 发件人邮箱 | From Email |
| `resend` | `chat_id` | `chat_id` | 否 | 收件人邮箱 | Recipient Emails |
| `smtp` | `chat_id` | `chat_id` | 是 | 发件人邮箱 | From Email |
| `smtp` | `token` | `token` | 是 | 授权码 / 应用密码 | Password / App Password |
| `smtp` | `webhook` | `webhook` | 是 | SMTP 服务器 | SMTP Server |
| `smtp` | `secret` | `secret` | 是 | SMTP 端口 | SMTP Port |
| `telegram` | `token` | `token` | 是 | Bot Token | Bot Token |
| `telegram` | `chat_id` | `chat_id` | 是 | Chat ID | Chat ID |
| `line` | `token` | `token` | 是 | Channel Access Token | Channel Access Token |
| `line` | `chat_id` | `chat_id` | 是 | 用户 ID 或群组 ID | User ID / Group ID |
| `matrix` | `homeserver` | `webhook` | 是 | Homeserver URL | Homeserver URL |
| `matrix` | `token` | `token` | 是 | Access Token | Access Token |
| `matrix` | `roomId` | `chat_id` | 是 | Room ID | Room ID |
| `mattermost` | `webhook` | `webhook` | 是 | 服务器 URL | Server URL |
| `mattermost` | `token` | `token` | 是 | Bot Access Token | Bot Access Token |
| `mattermost` | `chat_id` | `chat_id` | 是 | 频道 ID | Channel ID |
| `msteams` | `token` | `token` | 是 | Bot Framework Token | Bot Framework Token |
| `msteams` | `chat_id` | `chat_id` | 是 | Teams 频道 ID | Teams Channel ID |
| `nextcloud_talk` | `webhook` | `webhook` | 是 | Nextcloud URL | — |
| `nextcloud_talk` | `token` | `token` | 是 | App Password | — |
| `nextcloud_talk` | `chat_id` | `chat_id` | 是 | Talk 房间 Token | — |
| `wxpusher` | `token` | `token` | 是 | AppToken | App Token |
| `wxpusher` | `chat_id` | `chat_id` | 是 | UID | User UID |
| `qmsg` | `token` | `token` | 是 | Qmsg Key | Key |
| `qmsg` | `chat_id` | `chat_id` | 是 | QQ 号码 | QQ Number |
| `serverchan` | `token` | `token` | 是 | SendKey | — |
| `pushplus` | `token` | `token` | 是 | Token | — |
| `pushplus` | `chat_id` | `chat_id` | 否 | 群组编码 (可选) | — |
| `bark` | `webhook` | `webhook` | 是 | 服务器地址 | — |
| `bark` | `token` | `token` | 是 | Device Key | — |
| `bark` | `chat_id` | `chat_id` | 否 | 分组 (可选) | — |
| `bark` | `secret` | `secret` | 否 | 铃声 (可选) | — |
| `gotify` | `webhook` | `webhook` | 是 | 服务器地址 | — |
| `gotify` | `token` | `token` | 是 | App Token | — |
| `gotify` | `chat_id` | `chat_id` | 否 | 优先级 (可选) | — |
| `meow` | `token` | `token` | 是 | 昵称 (Nickname) | — |
| `pushme` | `token` | `token` | 是 | Push Key | — |
| `pushdeer` | `token` | `token` | 是 | PushKey | — |
| `pushdeer` | `webhook` | `webhook` | 否 | API 地址（可选） | — |
| `twilio` | `token` | `token` | 是 | Account SID | — |
| `twilio` | `secret` | `secret` | 是 | Auth Token | — |
| `twilio` | `webhook` | `webhook` | 是 | 发信号码 (From) | — |
| `twilio` | `chat_id` | `chat_id` | 是 | 收件号码 (To) | — |
| `wecomapp` | `token` | `token` | 是 | CorpID | — |
| `wecomapp` | `secret` | `secret` | 是 | CorpSecret | — |
| `wecomapp` | `chat_id` | `chat_id` | 是 | AgentID | — |
| `wecomapp` | `webhook` | `webhook` | 是 | 接收人 (touser) | — |
| `ntfy` | `webhook` | `webhook` | 是 | 服务器地址 | — |
| `ntfy` | `token` | `token` | 是 | Topic | — |
| `pushover` | `token` | `token` | 是 | User Key | — |
| `pushover` | `secret` | `secret` | 是 | App Token | — |
| `pushover` | `priority` | `chat_id` | 否 | 优先级 | — |
| `apprise` | `webhook` | `webhook` | 是 | Apprise 服务器地址 | — |
| `apprise` | `token` | `token` | 否 | 通知 URLs (可选) | — |
| `serverchan3` | `token` | `token` | 是 | SendKey (sctp...) | — |
| `serverchan3` | `webhook` | `webhook` | 否 | UID (可选) | — |
| `xizhi` | `token` | `token` | 是 | 息知 Key | — |
| `anpush` | `token` | `token` | 是 | Push Token | — |
| `anpush` | `chat_id` | `chat_id` | 否 | 通道 ID (可选) | — |
| `chanify` | `webhook` | `webhook` | 否 | 服务器地址 (可选) | — |
| `chanify` | `token` | `token` | 是 | 设备 Token | — |
| `pushback` | `token` | `token` | 是 | Access Token (at_...) | — |
| `pushback` | `chat_id` | `chat_id` | 是 | User ID (User_...) | — |
| `simplepush` | `token` | `token` | 是 | Key | — |
| `zulip` | `webhook` | `webhook` | 是 | 组织地址 | — |
| `zulip` | `token` | `token` | 是 | API Key | — |
| `zulip` | `chat_id` | `chat_id` | 是 | Bot 邮箱 | — |
| `zulip` | `secret` | `secret` | 是 | Stream 名称 | — |
| `fcm` | `token` | `token` | 是 | 服务账号 JSON | — |
| `fcm` | `chat_id` | `chat_id` | 是 | 设备令牌 / topic | — |
| `twilio_whatsapp` | `token` | `token` | 是 | Account SID | — |
| `twilio_whatsapp` | `secret` | `secret` | 是 | Auth Token | — |
| `twilio_whatsapp` | `webhook` | `webhook` | 是 | 发信号码 (From) | — |
| `twilio_whatsapp` | `chat_id` | `chat_id` | 是 | 收件号码 (To) | — |

## 3. Serverless 不可用渠道（8）

| ID | 原因 |
|----|------|
| `wechat_personal` | 需要本地微信插件会话，需常驻进程 |
| `whatsapp` | 需要 WhatsApp Web 插件会话，需常驻进程 |
| `qq_bot` | 需要 QQ 机器人插件，需常驻进程 |
| `signal` | 需要 Signal CLI 本地进程 |
| `imessage` | 需要 BlueBubbles/macOS 本地服务 |
| `zalo` | 需要 Zalo 插件会话 |
| `clawbot` | 需要 Clawbot 本地代理 |
| `nostr` | 需要长连接 Nostr relay |

## 4. 权威计数（生成值）

| 项 | 值 |
|----|----|
| 云端渠道总数 | 42 |
| webhook 渠道 | 11 |
| token 渠道 | 31 |
| 有 provider 专属连接测试 | 42 |
| Serverless 不可用 | 8 |
| schema 版本 | v75 |
