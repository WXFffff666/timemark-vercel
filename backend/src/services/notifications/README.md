# Notification Channels

This directory contains notification channel implementations and configuration.

## Vercel / Cloud Deploy

**Only HTTP-based channels are exposed** (Webhook URL or Bot Token). Plugin / IM channels are excluded via `supported-channels.ts`:

| Removed ID | Reason |
|------------|--------|
| `wechat_personal`, `whatsapp`, `qq_bot`, `signal`, `imessage`, `zalo`, `clawbot` | QR login, local process, or persistent connection |
| `nostr` | Long-lived relay connections |

## File Structure

- `index.ts` — Main notification dispatcher
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
