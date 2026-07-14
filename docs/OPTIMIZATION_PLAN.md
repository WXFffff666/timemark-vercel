# TimeMark 优化计划与实施记录

## 已完成（v2.7.0）

### 单账户鉴权加固
- JWT 载荷嵌入 `sessionToken`，与服务端 `sessions` 表绑定
- `authMiddleware` 校验 Session 是否有效/未过期
- 修复 `logout`：按 sessionId 或 JWT 内 sessionToken 删除会话
- 改密后吊销该用户其余全部 Session
- 登录成功返回 `sessionId`；`login_attempts` 表写入与清零

### 去除冗余
- 删除未使用的 `AccountSettings` / `RelationshipSettings` / `TemplateSettings`
- 删除遗留 `backend/src/init.ts`、`frontend/public/register.html`
- 移除 `Reminders` / `LoginHistory` 的 mock 假数据

### 补全缺失功能
- **Web Push**：`sw.js` + `lib/push.ts`，Settings 页完整订阅/取消
- **数据备份**：Settings 导出/导入 `/api/data/*`
- **图形化看板**：新增 `/analytics`（Recharts 柱状图/饼图）
- **年度报告**：增加成功率与饼图可视化

### 后端增强
- `/api/stats` 扩展月度趋势、事件类型、渠道分布

---

## 后续优化建议

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P0 | 外部 Cron | Hobby 计划需 [cron-job.org](https://cron-job.org) 每分钟调用 `/api/cron/reminder-check` |
| P0 | 环境变量 | `DATABASE_URL`、`JWT_SECRET`、`MASTER_KEY`、`CRON_SECRET`、`CORS_ORIGIN` |
| P1 | 渠道配置合并 | 将 `shared/channels.ts` 与 `channels.config.ts` 统一为单一数据源 |
| P1 | HttpOnly Cookie | 长期可考虑将 Token 迁至 HttpOnly Cookie，降低 XSS 风险 |
| P2 | E2E 测试 | Playwright 覆盖登录、事件 CRUD、提醒触发 |
| P2 | 日历视图 | 月历热力图展示即将到来的事件 |
| P2 | 冲突检测 UI | 接入已有 `/api/features/conflicts` |
| P3 | Passkeys | Better Auth 或 WebAuthn 无密码登录 |

---

## Vercel 部署清单

1. 在 Vercel 导入 GitHub 仓库 `WXFffff666/timemark-vercel`
2. 安装命令：`pnpm install --config.blockExoticSubdeps=false`
3. 构建命令：`pnpm build`
4. 输出目录：`frontend/dist`
5. 添加 Neon Postgres 并设置环境变量
6. 部署后运行：`npx tsx scripts/migrate-db.ts`
7. 配置 cron-job.org → `GET https://<domain>/api/cron/reminder-check`，Header: `Authorization: Bearer <CRON_SECRET>`
8. 首次登录后修改默认密码 `TimeMark@2026`

---

## 项目结构（规范后）

```
timemark-vercel/
├── api/[[route]].ts      # Vercel Serverless 入口
├── frontend/             # React SPA
├── backend/              # Hono API + 通知服务
├── shared/               # 类型、Schema、工具
├── scripts/              # 数据库迁移
├── docs/                 # 文档
└── vercel.json           # 部署配置
```
