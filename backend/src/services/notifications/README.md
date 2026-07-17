# Notification Channels

This directory contains notification channel implementations and configuration.

## Vercel / Cloud Deploy

**Only HTTP-based channels are exposed** (Webhook URL or Bot Token). Plugin / IM channels are excluded via `supported-channels.ts`:

| Removed ID | Reason |
|------------|--------|
| `wechat_personal`, `whatsapp`, `qq_bot`, `signal`, `imessage`, `zalo`, `clawbot` | QR login, local process, or persistent connection |
| `nostr` | Long-lived relay connections |

## Email / Resend recipient resolution

When sending email (`email` or `resend` channel), recipients are resolved in order:

1. Event `reminder_config.emailRecipients` (explicit per-event)
2. User `default_test_email` (Settings → 默认测试/收件邮箱)
3. User `reminder_emails` list
4. Channel account `chat_id` (optional per-channel override, lowest priority)

`reminder_recipient_email` is metadata only and does not override the above.

Channel test and event test-send use the same logic. Failures return explicit errors (no silent success).

**Resend API Key** is stored per notification account (encrypted with `MASTER_KEY`), not as a global `RESEND_API_KEY` env var.

User-facing guide: [docs/NOTIFICATIONS.md](../../../docs/NOTIFICATIONS.md)

## Retry queue

Failed sends enqueue `notification_queue` with backoff: 5m → 30m → 2h → 6h. Processed by `/api/cron/retry-notifications`.

## File Structure

- `index.ts` — Main notification dispatcher (`resolveRecipientEmails`, conflict hints)
- `channels.config.ts` — Channel definitions; `getSupportedChannelTemplates()` filters cloud-safe channels
- `supported-channels.ts` — Blocklist for Vercel / serverless
- `test-connection.ts` — Connection testing utilities
- `im-auth.vercel-stub.ts` — Stub for removed IM services in Vercel bundle
- `*.service.ts` — Individual channel implementations (HTTP only in production)

## Adding a New HTTP Channel

1. Create `newchannel.service.ts` with `sendNotification()` function
2. Add channel definition in `channels.config.ts` (`webhook` or `token` method)
3. Add dispatch branch in `index.ts`
4. Ensure the channel ID is **not** in `UNSUPPORTED_CHANNEL_IDS`
5. Update frontend `EventForm.tsx` channel picker if needed

## Channel Categories (Cloud)

| Category | Examples |
|----------|----------|
| Webhook | Discord, Slack, Feishu, DingTalk, WeCom |
| Token | Telegram, Resend, SMTP, WxPusher, Bark, ntfy, Pushover |

Plugin-based channels (WeChat personal, WhatsApp, etc.) exist only in the Docker edition codebase and are not available on Vercel.
