# Notification Channels

This directory contains implementations for 35+ notification channels.

## File Structure

- `index.ts` - Main notification dispatcher
- `channels.config.ts` - Channel definitions and configuration
- `test-connection.ts` - Connection testing utilities
- `*.service.ts` - Individual channel implementations

## Adding a New Channel

1. Create `newchannel.service.ts` with `sendNotification()` function
2. Add channel definition in `channels.config.ts`
3. Add dispatch logic in `index.ts`
4. Update `shared/src/channels.ts` for frontend

## Channel Categories

| Category | Count | Examples |
|----------|-------|---------|
| Webhook | 10 | Discord, Slack, 飞书, 企业微信 |
| Token | 18 | Telegram, Resend, SMTP, WxPusher |
| Plugin | 7 | WeChat, WhatsApp, QQ Bot |
