# Channel Compatibility Matrix

> Audit of notification channel services across **Vercel** (cloud, HTTP-only) and the separate **Docker** edition.
> 云端渠道的权威清单由 `scripts/gen-channel-matrix.mjs` 生成 → [CHANNEL_MATRIX.md](./CHANNEL_MATRIX.md)（51 个渠道，含字段 → 数据库列映射与连接测试路径）。

## Vercel Cloud Deploy (HTTP channels only)

On Vercel serverless, only **Webhook / Token** channels are available. The following are **removed from API and UI** (see `backend/src/services/notifications/supported-channels.ts`):

| Channel ID | Docker | Vercel | Reason |
|------------|:------:|:------:|--------|
| `wechat_personal` | ✅ | ❌ | Wechaty QR + Puppet |
| `whatsapp` | ✅ | ❌ | Baileys WebSocket |
| `qq_bot` | ✅ | ❌ | OICQ + QR login |
| `signal` | ✅ | ❌ | Signal CLI |
| `imessage` | ✅ | ❌ | BlueBubbles plugin |
| `zalo` | ✅ | ❌ | Plugin session |
| `clawbot` | ✅ | ❌ | Persistent ilink API |
| `nostr` | ✅ | ❌ | Relay long connection |
| Web Push (browser) | partial | ❌ | Not in Vercel Settings UI |

**51 channels** remain available on cloud (Feishu, DingTalk, Telegram, email, Bark, ServerChan, …). The authoritative list — IDs, `configMethod`, required fields → `notification_accounts` column mapping, connection-test path and official URL — is generated into [CHANNEL_MATRIX.md](./CHANNEL_MATRIX.md). Do not hand-maintain channel lists in this document.

---

## Docker Full Deploy (separate repo)

The Docker edition lives in its own repository: [timemark-docker](https://github.com/WXFffff666/timemark-docker). It ships **38 channels** (including the plugin/QR and long-connection channels that serverless cannot host); its own deployment docs and dependency audit live there.

The previous "39 notification channel services" Alpine audit was removed from this repo: it described the pre-fork Docker codebase, referenced `shared/src/channels.ts` (deleted under R5.2 — this repo now has a single authoritative catalogue in `backend/src/services/notifications/channels.config.ts`), and its "unused dependency" claims no longer matched `backend/package.json`. Channel dependency notes for the Docker edition belong to the Docker repo.

Dependency state of the Vercel repo after the Wave-3 cleanup (2026-09): the dead plugin-channel services and their exotic dependencies are gone — no `baileys`, `oicq`, `wechaty` or `@tencent-weixin/openclaw-weixin`; `nostr-tools` was only used by the removed `nostr.service.ts` and is gone too. `qrcode` stays because `backend/src/routes/security.ts` renders the TOTP 2FA QR code; `web-push` stays for the browser-push channel. There is no `optionalDependencies` block left and no exotic-subdeps override anywhere.

---

## Adding a channel (Vercel)

1. Implement `*.service.ts` under `backend/src/services/notifications/`.
2. Add the template to `channels.config.ts` (with `configMethod` and, for fields not named `webhook`/`token`/`secret`/`chat_id`, an explicit `column`).
3. Add a truthful provider-specific branch in `test-connection.ts` (invalid fixtures must fail).
4. Run `node scripts/gen-channel-matrix.mjs` and update the counts in `README.md` until it exits 0.
