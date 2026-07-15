# 安全评估报告

**目标**：`https://timemark.the37777777.top`  
**最新版本**：v2.12.0（2026-07-15）

## 已通过项

| 项目 | 结果 |
|------|------|
| 未授权访问 `/api/auth/session`、`/api/events`、`/api/data/export` | 401 |
| Cron `/api/cron/*` 无/错误 Bearer | 401 |
| SQL 注入登录 payload | 400 校验拒绝 |
| 路径穿越 `/api/auth/../../../etc/passwd` | 返回 SPA，无文件泄露 |
| 速率限制 `/api/auth/login` | 429 |
| 安全响应头 | CSP、X-Frame-Options DENY、nosniff、HSTS |
| Turnstile | `enabled: true`，未带 token 无法完成登录 |
| Cookie | HttpOnly + SameSite=Lax + Secure（Vercel 生产） |
| 首次登录改密 | `mustChangePassword` 在 `password_changed_at` 为空时触发 |

## v2.11.0 已修复

1. **`/api/health` 信息泄露**：公开接口不再返回 `jwtSecret`/`masterKey`/`cronSecret`/`commit`；仅 `?detailed=1` + `X-Health-Token` 可查看详情。
2. **Cookie `Secure` 标志**：Vercel 生产环境强制 `secure: true`。
3. **前后端密码长度**：统一最少 8 位。
4. **冗余文档**：删除 Docker 版 `DEPLOYMENT.md`、`PROJECT_DOC.md`。

## v2.12.0 最终加固（本次）

### CSP

- 移除 `script-src 'unsafe-inline'`（Vite 生产构建无内联脚本依赖）。
- 新增 `script-src-attr 'none'`、`form-action 'self'`。
- `style-src` 保留 `'unsafe-inline'`（React/Tailwind 运行时样式注入）。

### 密钥与日志

| 改动 | 文件 |
|------|------|
| 生产环境禁止 JWT 弱默认回退 | `backend/src/utils/jwt.ts` |
| 生产环境禁止 MASTER_KEY 弱默认回退 | `secrets.ts`、`clawbot.service.ts`、`wechat-openclaw.service.ts` |
| 移除默认密码明文日志 | `index.ts`、`migrate-db.ts` |
| 移除 VAPID 私钥日志 | `push.ts` |
| 移除事件调试 `console.log` | `events.ts` |
| `setup-vercel-production.ps1` 随机生成管理员密码 | 脚本输出一次，不再硬编码 |

### 数据导出脱敏

- `/api/data/export` 对 `notification_accounts` 的 `token`/`secret`/`webhook`/`session_data` 及 `user_configs` 中 SMTP/API 密钥字段输出 `[redacted]`。

### 部署清理

- 删除 Docker 遗留：`Dockerfile`、`docker-compose*.yml`（7 个文件）。

### 环境变量策略

- 文档明确：`JWT_SECRET`、`MASTER_KEY`、`TURNSTILE_SECRET_KEY`、`CRON_SECRET`、`DEFAULT_ADMIN_PASSWORD` 等**仅勾选 Vercel Production**，勿勾选 Preview/Development。

## 复测命令（浏览器控制台）

```javascript
fetch('/api/health').then(r => r.json()).then(console.log)
// 应无 jwtSecret / masterKey / cronSecret 字段
```

## 建议持续关注

| 风险 | 建议 |
|------|------|
| CSP `style-src unsafe-inline` | React 迁移至 nonce/hash 后可进一步收紧 |
| Turnstile Site Key 公开 | 正常；Secret 仅服务端 Production |
| 默认管理员密码 | 使用 `setup-vercel-production.ps1` 随机密码或自定义 `DEFAULT_ADMIN_PASSWORD` |
| Preview 域名 | 保持 Vercel Standard Protection；Secret 不注入 Preview |
