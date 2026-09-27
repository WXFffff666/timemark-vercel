# Vercel Serverless Stub 文件说明 (B40)

Vercel 部署通过 `scripts/build-vercel-api.mjs` 将后端打包为单个 serverless bundle。部分模块在 serverless 环境中不可用（本地进程、长连接、重型依赖），因此保留 stub 文件替代真实实现。

## 必须保留的 Stub

| 文件 | 原因 | 替代方案 |
|------|------|----------|
| `backend/src/queue/scheduler.vercel-stub.ts` | Vercel 无常驻进程，定时任务改由 `/api/cron/*` + 外部 Cron 触发 | esbuild 插件将 `scheduler.js` 解析到 stub |
| `backend/src/routes/push.vercel-stub.ts` | Web Push 订阅在部分 serverless 环境受限；保留 VAPID 公钥端点，订阅返回 501 | 未接入主路由（`index.ts` 使用 `push.ts`）；Docker 版使用完整实现 |

## 已删除的 Stub（Wave 3，2026-09）

插件类渠道服务（`whatsapp` / `wechaty` / `qqbot` / `signal` / `zalo` / `bluebubbles` / `clawbot` / `wechat-openclaw` / `nostr`）已整体删除，它们对应的 `im-auth.vercel-stub.ts` 不再需要 esbuild redirect；未被任何插件引用的 `email.vercel-stub.ts`、`network-check.vercel-stub.ts`、`test-connection.vercel-stub.ts` 一并删除。渠道目录由 `channels.config.ts` + `supported-channels.ts` 唯一决定，见 `channel-integrity.test.ts` 的不变量测试。`notifications.vercel-stub.ts`（services 目录下的空 dispatcher）仍作为历史参考保留，未被任何插件或路由引用。

## 不可删除的原因总结

1. **scheduler stub** — 本地 Docker 版 `index.ts` 在 `!VERCEL` 时动态 import 真实 scheduler；Vercel bundle 必须提供同名导出避免打包失败。
2. **push stub** — 独立文件，供未来条件切换；当前生产路由仍用 `push.ts`（web-push 在 Node runtime 可用）。

## 维护建议

- 新增 Vercel 不支持的模块时，优先在 `build-vercel-api.mjs` 添加 esbuild redirect，而非修改业务代码。
- 删除 unused stub 前运行 `pnpm build` 与 Vercel API bundle 构建确认无回归。
