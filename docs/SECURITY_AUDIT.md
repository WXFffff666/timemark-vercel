# 安全评估报告（浏览器渗透）

**目标**：`https://timemark.the37777777.top`  
**时间**：2026-07-15  
**方式**：浏览器内 `fetch` 探测（未安装第三方渗透工具）

## 已通过项

| 项目 | 结果 |
|------|------|
| 未授权访问 `/api/auth/session`、`/api/events`、`/api/backup/export` | 401 |
| Cron `/api/cron/*` 无/错误 Bearer | 401 |
| SQL 注入登录 payload | 400 校验拒绝 |
| 路径穿越 `/api/auth/../../../etc/passwd` | 返回 SPA，无文件泄露 |
| 速率限制 `/api/auth/login` | 429「请求过于频繁」 |
| 安全响应头 | CSP、X-Frame-Options DENY、nosniff、HSTS |
| Turnstile | `enabled: true`，未带 token 无法完成登录探测 |
| Cookie | HttpOnly + SameSite=Lax（已加固 Secure on Vercel） |

## 已修复项（本次提交）

1. **`/api/health` 信息泄露**：公开接口不再返回 `jwtSecret`/`masterKey`/`cronSecret`/`commit`；仅 `?detailed=1` + `X-Health-Token` 可查看详情（需配置 `HEALTH_DETAIL_TOKEN`）。
2. **Cookie `Secure` 标志**：Vercel 生产环境强制 `secure: true`。
3. **前后端密码长度不一致**：登录页提示与校验统一为最少 8 位（与 `loginSchema` 一致）。
4. **冗余文档**：删除 Docker 版 `DEPLOYMENT.md`、`PROJECT_DOC.md`。

## 建议后续（未改代码）

| 风险 | 建议 |
|------|------|
| CSP `unsafe-inline` | 逐步去掉内联脚本，收紧 CSP |
| Turnstile Site Key 公开 | 正常；Secret 仅服务端 |
| 默认管理员密码 | 首次登录后务必修改 |
| Preview 环境变量 | Secret 类变量仅 Production |

## 复测命令（浏览器控制台）

```javascript
fetch('/api/health').then(r => r.json()).then(console.log)
// 应无 jwtSecret / masterKey / cronSecret 字段
```
