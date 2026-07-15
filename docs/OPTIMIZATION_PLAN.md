# TimeMark 优化计划与实施记录

## 已完成（v2.10.0）

### Passkeys / WebAuthn
- 注册：`安全中心 → Passkey` 绑定设备（指纹/面容/安全密钥）
- 登录：登录页「使用 Passkey 登录」（需先输入用户名）
- API：`/api/auth/webauthn/*`（基于 `@simplewebauthn`）
- 迁移 **v19**：`webauthn_challenges` 表 + credentials 扩展字段
- 可选环境变量：`WEBAUTHN_RP_ID`、`WEBAUTHN_RP_NAME`、`WEBAUTHN_ORIGIN`

---

## 已完成（v2.9.1）

### 关键 Bug
- **设置页卡死**：部署向导图标误用 `<Settings />` 组件自身，导致无限递归渲染
- **页面切换慢**：移除 `AnimatePresence mode="wait"`；路由 chunk 预加载；vendor 分包

### 域名
- 仅允许 `https://timemark.the37777777.top`（`CORS_ORIGIN` 不再包含 vercel.app）
- `middleware.ts`：访问 `*.vercel.app` 自动 308 跳转到正式域名

---

## 已完成（v2.9.0）

### Bug 修复
- **设置页崩溃**：`alert_channels` 非数组或 JSON 解析失败时安全降级
- **安全中心**：新增返回键；API 失败时显示错误与重试
- **功能入口**：首页直达固定联系人、批量邮件、日历视图

### 新功能
- **日历月视图**：`/calendar` 月历格展示事件
- **冲突检测 UI**：首页展示同日期多事件冲突
- **PushDeer 渠道**：官方/自建 API 推送
- **HttpOnly Cookie**：登录/刷新 Token 写入 HttpOnly Cookie，降低 XSS 风险
- **事件表单**：可从固定联系人快捷填入被提醒人/提醒人

---

## 已完成（v2.8.0）

### P0 缺陷修复
- LINE / Microsoft Teams 接入主发送链
- `calendar_type: both` 双历调度支持
- Google Chat / IRC 专用 API（不再走 generic）
- 迁移 v16→v17 顺序修正；新增 v18（联系人、批量邮件）

### 新功能
- **固定联系人**：`/api/contacts` + `/contacts` 页面，保存时格式验证
- **批量邮件**：Resend Batch API，`/api/broadcast` + `/broadcast` 页面
- **渠道健康检测**：保存账户自动 test；Cron `/api/cron/channel-health`
- **Cron 心跳**：`HEALTHCHECK_URL` 环境变量（Healthchecks.io 等）
- **模板扩充**：农历/双历/节日/批量邮件预设模板

### 长期可用性
- `/api/health` 展示最近 Cron 执行记录
- `cron_execution_logs` + 可选外部心跳

### 环境变量（新增可选）
| 变量 | 说明 |
|------|------|
| `HEALTHCHECK_URL` | Cron 成功后 ping（如 Healthchecks.io） |

---

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
- **Web Push**：Vercel 云端版已移除浏览器推送设置（`sw.js` 仍保留于代码库，Docker 版可用）
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
| P3 | Passkeys | ~~Better Auth 或 WebAuthn 无密码登录~~ **v2.10 已实现** |

---

## Vercel 部署清单

1. 在 Vercel 导入 GitHub 仓库 `WXFffff666/timemark-vercel`
2. 安装命令：`pnpm install --config.blockExoticSubdeps=false`
3. 构建命令：`pnpm build`
4. 输出目录：`frontend/dist`
5. 添加 Neon Postgres 并设置环境变量
6. 部署后运行：`npx tsx scripts/migrate-db.ts`
7. 配置 cron-job.org → `GET /api/cron/reminder-check`（每分钟）
8. 可选：每日 `GET /api/cron/channel-health`；设置 `HEALTHCHECK_URL` 心跳
9. 首次登录后修改默认密码 `TimeMark@2026`

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
