# 安全评估报告

**目标**：`https://timemark.the37777777.top`  
**最新版本**：v2.15.0（2026-07-17）

## 已通过项

| 项目 | 结果 |
|------|------|
| 未授权访问 `/api/auth/session`、`/api/events`、`/api/contacts`、`/api/data/export` | 401 |
| 未授权 POST `/api/contacts/:id/send-email` | `Missing origin or authorization` / 401 |
| Cron `/api/cron/*` 无/错误 Bearer | 401 |
| SQL 注入登录 payload | 400 校验拒绝 |
| 路径穿越 `/api/auth/../../../etc/passwd` | 返回 SPA，无文件泄露 |
| 速率限制 `/api/auth/login` | 429 |
| 安全响应头 | CSP、X-Frame-Options DENY、nosniff、HSTS |
| Turnstile | `enabled: true`，未带 token 无法完成登录 |
| Cookie | HttpOnly + SameSite=Lax + Secure（Vercel 生产） |
| 首次登录改密 | `mustChangePassword` 在 `password_changed_at` 为空时触发 |
| 传输加密 | 生产全站 HTTPS；SMTP 587 强制 STARTTLS |

## v2.15.0 加固（本次）

### 联系人快捷发信

| 问题 | 修复 |
|------|------|
| `recipientEmails` 可填任意邮箱，构成开放中继 | 服务端校验收件人 ⊆ 联系人邮箱列表 |
| 发信日志无 `user_id` | 改用 `logEmail({ userId, ... })` |

### 密钥与 API 响应

| 改动 | 说明 |
|------|------|
| `GET /api/config/accounts` 脱敏 | 不返回明文 `token`/`secret`/`session_data` |
| 创建/更新账号响应脱敏 | 同上，编辑时留空表示不修改（`tokenConfigured` 标志） |
| 前端渠道页 | 已配置密钥显示「已配置，留空则不修改」 |

### 传输与头部

| 改动 | 说明 |
|------|------|
| HSTS | `security-headers.ts` + `vercel.json` |
| SMTP `requireTLS` | `email-send.service.ts`、`smtp.service.ts`（587 端口） |
| CORS `*` 禁用 | `allowed-origins.ts` 不再在 credentials 模式下返回 `*` |

### 待办数据

| 行为 | 说明 |
|------|------|
| 完成记录 | `todo_completions` 按用户隔离，写操作校验 `events.user_id` |
| 历史保留 | 默认 365 天后 `daily-maintenance` 清理 |

## v2.11.0 已修复

1. **`/api/health` 信息泄露**：公开接口不再返回 `jwtSecret`/`masterKey`/`cronSecret`/`commit`；仅 `?detailed=1` + `X-Health-Token` 可查看详情。
2. **Cookie `Secure` 标志**：Vercel 生产环境强制 `secure: true`。
3. **前后端密码长度**：统一最少 8 位。
4. **冗余文档**：删除 Docker 版 `DEPLOYMENT.md`、`PROJECT_DOC.md`。

## v2.12.0 最终加固

### CSP

- 移除 `script-src 'unsafe-inline'`（Vite 生产构建无内联脚本依赖）。
- 新增 `script-src-attr 'none'`、`form-action 'self'`。
- `style-src` 保留 `'unsafe-inline'`（React/Tailwind 运行时样式注入）。

### 密钥与日志

| 改动 | 文件 |
|------|------|
| 生产环境禁止 JWT 弱默认回退 | `backend/src/utils/jwt.ts` |
| 生产环境禁止 MASTER_KEY 弱默认回退 | `secrets.ts` |
| 移除默认密码明文日志 | `index.ts`、`migrate-db.ts` |
| `/api/data/export` 脱敏 | `backend/src/routes/data.ts` |

### 环境变量策略

- 文档明确：`JWT_SECRET`、`MASTER_KEY`、`TURNSTILE_SECRET_KEY`、`CRON_SECRET`、`DEFAULT_ADMIN_PASSWORD` 等**仅勾选 Vercel Production**，勿勾选 Preview/Development。

## 复测命令

### 健康检查（浏览器控制台）

```javascript
fetch('/api/health').then(r => r.json()).then(console.log)
// 应无 jwtSecret / masterKey / cronSecret 字段
```

### 响应头（命令行）

```bash
curl.exe -sI https://timemark.the37777777.top/
# 应含 Strict-Transport-Security、Content-Security-Policy、X-Frame-Options: DENY
```

### 未授权 API

```bash
curl.exe -s https://timemark.the37777777.top/api/contacts
# {"success":false,"error":"Unauthorized"}
```

## 建议持续关注

| 风险 | 建议 |
|------|------|
| CSP `style-src unsafe-inline` | React 迁移至 nonce/hash 后可进一步收紧 |
| Turnstile Site Key 公开 | 正常；Secret 仅服务端 Production |
| 默认管理员密码 | 使用强 `DEFAULT_ADMIN_PASSWORD` 并首次登录改密 |
| Preview 域名 | 保持 Vercel Standard Protection；Secret 不注入 Preview |
| XSS + 已登录会话 | 密钥已脱敏；仍应避免在不可信页面执行脚本 |
| 批量邮件手动收件人 | 认证用户可向自选邮箱群发，建议开启 2FA 与 TOTP 大批量限制 |

## 相关代码

| 模块 | 路径 |
|------|------|
| 认证中间件 | `backend/src/middleware/auth.middleware.ts` |
| CSRF | `backend/src/middleware/csrf.ts` |
| 安全响应头 | `backend/src/middleware/security-headers.ts` |
| 密钥脱敏 | `backend/src/utils/secret-mask.ts` |
| 联系人发信 | `backend/src/services/contact-send.service.ts` |
| 密码哈希 | `backend/src/utils/password.ts` |
