# Vercel Serverless Stub 文件说明 (B40)

Vercel 部署通过 `scripts/build-vercel-api.mjs` 将后端打包为单个 serverless bundle。部分模块在 serverless 环境中不可用（本地进程、长连接、重型依赖），因此保留 stub 文件替代真实实现。

## 必须保留的 Stub

| 文件 | 原因 | 替代方案 |
|------|------|----------|
| `backend/src/queue/scheduler.vercel-stub.ts` | Vercel 无常驻进程，定时任务改由 `/api/cron/*` + 外部 Cron 触发 | esbuild 插件将 `scheduler.js` 解析到 stub |
| `backend/src/services/notifications/im-auth.vercel-stub.ts` | WeChat/WhatsApp/QQ 等 IM 渠道需 QR 登录与本地进程，Vercel 不支持 | esbuild 插件将 IM service 导入重定向到 stub |
| `backend/src/routes/push.vercel-stub.ts` | Web Push 订阅在部分 serverless 环境受限；保留 VAPID 公钥端点，订阅返回 501 | 未接入主路由（`index.ts` 使用 `push.ts`）；Docker 版使用完整实现 |

## 备用 Stub（当前未接入 build 插件）

以下文件为历史遗留或备用，**未**被 `build-vercel-api.mjs` 引用，也未被 `index.ts` 条件导入。保留作为文档参考，删除需验证 esbuild 树摇结果：

| 文件 | 说明 |
|------|------|
| `notifications.vercel-stub.ts` | 空通知 dispatcher，未被引用 |
| `notifications/email.vercel-stub.ts` | 空邮件发送，未被引用 |
| `notifications/network-check.vercel-stub.ts` | 空网络检测，未被引用 |
| `notifications/test-connection.vercel-stub.ts` | 空连接测试，未被引用 |

## 不可删除的原因总结

1. **scheduler stub** — 本地 Docker 版 `index.ts` 在 `!VERCEL` 时动态 import 真实 scheduler；Vercel bundle 必须提供同名导出避免打包失败。
2. **im-auth stub** — 防止 esbuild 尝试打包 baileys/wechaty/oicq 等可选依赖（体积 >100MB，运行时不可用）。
3. **push stub** — 独立文件，供未来条件切换；当前生产路由仍用 `push.ts`（web-push 在 Node runtime 可用）。

## 维护建议

- 新增 Vercel 不支持的模块时，优先在 `build-vercel-api.mjs` 添加 esbuild redirect，而非修改业务代码。
- 删除 unused stub 前运行 `pnpm build` 与 Vercel API bundle 构建确认无回归。
