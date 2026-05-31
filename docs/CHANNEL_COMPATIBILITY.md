# Channel Compatibility Matrix

> Auto-generated audit of all 39 notification channel services.
> Base image: `node:20.18-alpine`
> System packages installed: `dumb-init`, `ca-certificates`, `icu-data-full`

## Summary

| Tier | Count | Description |
|------|-------|-------------|
| Tier 1 (Built-in) | 30 | Only uses `axios` + Node.js built-ins, works everywhere |
| Tier 2 (Token-based) | 3 | Needs specific npm packages (already in package.json) |
| Tier 3 (Plugin) | 4 | Needs heavy npm packages (wechaty, baileys, oicq) |
| Tier 4 (System) | 2 | Needs system-level tools not available in Alpine by default |

---

## Tier 1: Works Out-of-the-Box (axios only)

These channels only import `axios` and Node.js built-in modules (`crypto`, `fs`, `path`, `os`).
All dependencies are already in `package.json`. No extra system packages needed.

| # | Channel | Service File | External Imports | Config Method | Status |
|---|---------|-------------|-----------------|---------------|--------|
| 1 | Apprise | `apprise.service.ts` | `axios` | token | ✅ Ready |
| 2 | Bark | `bark.service.ts` | `axios` | token | ✅ Ready |
| 3 | BlueBubbles | `bluebubbles.service.ts` | `axios` | token | ✅ Ready |
| 4 | DingTalk | `dingtalk.service.ts` | `axios`, `crypto` (built-in) | webhook | ✅ Ready |
| 5 | Discord | `discord.service.ts` | `axios` | webhook | ✅ Ready |
| 6 | Feishu | `feishu.service.ts` | `axios` | webhook | ✅ Ready |
| 7 | Generic Webhook | `generic-webhook.service.ts` | `axios` | webhook | ✅ Ready |
| 8 | Google Chat | `googlechat.service.ts` | `axios` | webhook | ✅ Ready |
| 9 | Gotify | `gotify.service.ts` | `axios` | token | ✅ Ready |
| 10 | IRC | `irc.service.ts` | `axios` | webhook/token | ✅ Ready |
| 11 | LINE | `line.service.ts` | `axios` | token | ✅ Ready |
| 12 | Matrix | `matrix.service.ts` | `axios` | token | ✅ Ready |
| 13 | Mattermost | `mattermost.service.ts` | `axios` | token | ✅ Ready |
| 14 | Meow (喵推送) | `meow.service.ts` | `axios` | token | ✅ Ready |
| 15 | Microsoft Teams | `msteams.service.ts` | `axios` | token | ✅ Ready |
| 16 | Nextcloud Talk | `nextcloudtalk.service.ts` | `axios` | token | ✅ Ready |
| 17 | Ntfy | `ntfy.service.ts` | `axios` | token | ✅ Ready |
| 18 | PushMe | `pushme.service.ts` | `axios` | token | ✅ Ready |
| 19 | Pushover | `pushover.service.ts` | `axios` | token | ✅ Ready |
| 20 | PushPlus | `pushplus.service.ts` | `axios` | token | ✅ Ready |
| 21 | Qmsg (QQ) | `qmsg.service.ts` | `axios` | token | ✅ Ready |
| 22 | ServerChan | `serverchan.service.ts` | `axios` | token | ✅ Ready |
| 23 | Slack | `slack.service.ts` | `axios` | webhook | ✅ Ready |
| 24 | Synology Chat | `synologychat.service.ts` | `axios` | webhook | ✅ Ready |
| 25 | Telegram | `telegram.service.ts` | `axios` | token | ✅ Ready |
| 26 | Twitch | `twitch.service.ts` | `axios` | token | ✅ Ready |
| 27 | WeCom (企业微信) | `wecom.service.ts` | `axios` | webhook | ✅ Ready |
| 28 | WeComApp (企微应用) | `wecomapp.service.ts` | `axios` | token | ✅ Ready |
| 29 | WxPusher | `wxpusher.service.ts` | `axios` | token | ✅ Ready |
| 30 | Zalo | `zalo.service.ts` | `axios` | token/plugin | ✅ Ready |

---

## Tier 2: Requires npm Packages (already installed)

These channels use specific npm packages beyond `axios`. All are already in `package.json`.

| # | Channel | Service File | External Imports | npm Package | In package.json? | Status |
|---|---------|-------------|-----------------|-------------|-----------------|--------|
| 1 | Resend (Email) | `email.service.ts` | `resend` | `resend@^3.2.0` | ✅ Yes | ✅ Ready |
| 2 | SMTP (Email) | `smtp.service.ts` | `nodemailer` | `nodemailer@^8.0.6` | ✅ Yes | ✅ Ready |
| 3 | Nostr | `nostr.service.ts` | `nostr-tools/pure`, `nostr-tools/nip04`, `nostr-tools/relay`, `nostr-tools/utils` | `nostr-tools@^2.10.4` | ✅ Yes | ✅ Ready |

---

## Tier 3: Heavy Plugin Packages (installed but resource-intensive)

These channels use large npm packages that are already in `package.json` but may have significant resource overhead.

| # | Channel | Service File | External Imports | npm Package | In package.json? | Alpine Notes |
|---|---------|-------------|-----------------|-------------|-----------------|--------------|
| 1 | WeChat (Wechaty) | `wechaty.service.ts` | `wechaty`, `qrcode` | `wechaty@^1.20.2`, `qrcode@^1.5.3` | ✅ Yes | ⚠️ May need `chromium` for puppet-wechat4u; puppet selection matters |
| 2 | WhatsApp (Baileys) | `whatsapp.service.ts` | `baileys`, `qrcode`, `fs`, `path`, `os` | `baileys@^6.10.0`, `qrcode@^1.5.3` | ✅ Yes | ✅ Pure JS, works on Alpine |
| 3 | QQ Bot (OICQ) | `qqbot.service.ts` | `oicq` (dynamic import) | `oicq@^2.3.1` | ✅ Yes | ✅ Pure JS, works on Alpine |
| 4 | WeChat (ClawBot) | `clawbot.service.ts` | `axios`, `qrcode`, `@timemark/shared/crypto` | `qrcode@^1.5.3` | ✅ Yes | ✅ Uses HTTP API (iLink), no heavy deps |
| 5 | WeChat (OpenClaw) | `wechat-openclaw.service.ts` | `axios`, `child_process`, `qrcode`, `@timemark/shared/crypto` | `qrcode@^1.5.3`, `@tencent-weixin/openclaw-weixin@^1.0.0` | ✅ Yes | ⚠️ Spawns external CLI process (openclaw) |

---

## Tier 4: Requires System-Level Tools

These channels require tools/binaries not available in the Alpine Docker image by default.

| # | Channel | Service File | System Requirement | Available in Alpine? | Status |
|---|---------|-------------|-------------------|---------------------|--------|
| 1 | Signal | `signal.service.ts` | `signal-cli` (Java-based CLI tool) | ❌ Not installed | ❌ Requires: `openjdk11-jre`, `signal-cli` binary |
| 2 | WeChat (OpenClaw) | `wechat-openclaw.service.ts` | OpenClaw CLI binary | ❌ Not installed | ❌ Requires: OpenClaw CLI installation |

---

## Dependency Verification

### npm Packages Used by Channel Services

| Package | Used By | In `package.json`? | Status |
|---------|---------|-------------------|--------|
| `axios` | 30 channels | ✅ `^1.6.7` | ✅ OK |
| `resend` | email.service.ts | ✅ `^3.2.0` | ✅ OK |
| `nodemailer` | smtp.service.ts | ✅ `^8.0.6` | ✅ OK |
| `nostr-tools` | nostr.service.ts | ✅ `^2.10.4` | ✅ OK |
| `qrcode` | wechaty, whatsapp, clawbot, wechat-openclaw | ✅ `^1.5.3` | ✅ OK |
| `wechaty` | wechaty.service.ts | ✅ `^1.20.2` | ✅ OK |
| `baileys` | whatsapp.service.ts | ✅ `^6.10.0` | ✅ OK |
| `oicq` | qqbot.service.ts | ✅ `^2.3.1` | ✅ OK |
| `@tencent-weixin/openclaw-weixin` | wechat-openclaw.service.ts | ✅ `^1.0.0` | ✅ OK |
| `crypto` | dingtalk.service.ts | N/A (Node.js built-in) | ✅ OK |
| `child_process` | signal, wechat-openclaw | N/A (Node.js built-in) | ✅ OK |
| `fs`, `path`, `os` | whatsapp, signal | N/A (Node.js built-in) | ✅ OK |
| `web-push` | routes/push.ts (NOT a channel) | ✅ `^3.6.7` | ✅ OK |

### pluginPackage References (shared/src/channels.ts)

| pluginPackage Value | Actual Implementation | Match? | Notes |
|--------------------|----------------------|--------|-------|
| `@tencent-weixin/openclaw-weixin` | Uses axios + CLI spawn | ⚠️ Partial | Package installed but service uses HTTP API |
| `baileys` | `import * as Baileys from 'baileys'` | ✅ Match | |
| `openclaw-qqbot` | `import('oicq')` | ❌ Mismatch | Service uses `oicq`, not `openclaw-qqbot` |
| `signal-cli` | `spawn('signal-cli', ...)` | ⚠️ System tool | Not an npm package, it's a CLI binary |
| `openclaw-zalo` | `import axios` | ❌ Mismatch | Service uses Zalo OA API via axios |
| `nostr-tools` | `import from 'nostr-tools/*'` | ✅ Match | |

---

## Issues Found

### 1. Missing System Dependencies for Full Functionality

| Channel | Missing | Impact |
|---------|---------|--------|
| Signal | `signal-cli` + Java runtime | Channel will fail at runtime |
| WeChat (OpenClaw) | OpenClaw CLI binary | Channel will fail at runtime |
| WeChat (Wechaty) | Potentially `chromium` (depends on puppet) | May fail depending on puppet choice |

### 2. pluginPackage Mismatches in `shared/src/channels.ts`

| Channel ID | pluginPackage | Actual Dependency | Recommendation |
|-----------|--------------|-------------------|----------------|
| `qqbot` | `openclaw-qqbot` | `oicq` | Update pluginPackage to `oicq` |
| `zalo` | `openclaw-zalo` | `axios` (Zalo OA API) | Update pluginPackage to remove or mark as API-based |

### 3. Unused Dependencies in package.json

| Package | Declared In | Used By Channel Services? | Used Elsewhere? |
|---------|------------|--------------------------|-----------------|
| `web-push@^3.6.7` | package.json | ❌ No | ✅ Yes (routes/push.ts) |

---

## Alpine Docker Compatibility Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Alpine Docker (node:20.18-alpine) Compatibility             │
├─────────────────────────────────────────────────────────────┤
│ ✅ Works out-of-the-box:  35/39 channels (90%)             │
│ ⚠️  Needs config only:    2/39 channels (5%)              │
│ ❌ Needs system packages:  2/39 channels (5%)              │
├─────────────────────────────────────────────────────────────┤
│ Channels that work immediately:                             │
│   All Tier 1 (30) + Tier 2 (3) + Baileys + OICQ + ClawBot │
│                                                             │
│ Channels needing attention:                                 │
│   - Wechaty: depends on puppet (may need chromium)          │
│   - OpenClaw: needs CLI binary installation                 │
│   - Signal: needs signal-cli + Java runtime                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Recommendations

1. **For Docker deployment**: The 35 channels that work out-of-the-box cover the vast majority of use cases (Telegram, Discord, Slack, WeChat via WxPusher, Email, etc.)

2. **For Signal support**: Would require adding `openjdk11-jre` (~100MB) and `signal-cli` to the Docker image, significantly increasing image size. Consider making this optional.

3. **For Wechaty**: The default puppet (`wechaty-puppet-wechat4u`) is pure JS and should work on Alpine. Only `wechaty-puppet-padlocal` or browser-based puppets need chromium.

4. **For OpenClaw WeChat**: This requires the OpenClaw CLI which is a separate binary. Consider documenting this as an advanced/optional feature.

5. **Fix pluginPackage mismatches**: Update `shared/src/channels.ts` to reflect actual dependencies (`oicq` instead of `openclaw-qqbot`, remove `openclaw-zalo`).
