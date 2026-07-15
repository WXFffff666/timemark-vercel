# TimeMark Vercel 主计划（2026-07-15）

> 基于代码库全量审计 + 15 项联网调研 + 8 个同类 GitHub 项目对标 + 生产站点只读探测  
> 生产域名：`https://timemark.the37777777.top`  
> 版本基线：v2.7.0

---

## 一、项目现状摘要

### 1.1 架构

| 层级 | 技术 | 状态 |
|------|------|------|
| 前端 | React 18 + Vite + Tailwind + shadcn 风格组件 | ✅ 成熟 |
| 后端 | Hono + PostgreSQL (Neon) | ✅ 成熟 |
| 部署 | Vercel Serverless + cron-job.org 外部 Cron | ⚠️ 依赖外部 Cron |
| 共享包 | `@timemark/shared` 类型/Schema/加密 | ⚠️ 渠道定义重复 |

### 1.2 已确认缺陷（P0–P3）

| 优先级 | 问题 | 影响 |
|--------|------|------|
| **P0** | `calendar_type: both` 调度器未处理 | 双历事件永不提醒 |
| **P0** | LINE / Microsoft Teams 已 import 但未接入发送链 | 配置后无法送达 |
| **P0** | 外部 Cron 为 best-effort，无心跳监控 | 提醒可能静默失败 |
| **P1** | `shared/channels.ts` 与 `channels.config.ts` 双份定义 | 配置漂移 |
| **P1** | Google Chat / IRC 走 generic_webhook | 专用 API 未用 |
| **P1** | WebAuthn 表已建、API 未实现 | 功能半成品 |
| **P1** | `api-key.ts` 中间件未挂载 | 死代码 |
| **P2** | 农历转换前端/后端策略不一致（local noon vs UTC） | 边界日偏移 |
| **P2** | README 仍写 Docker/SQLite/5 Cron | 文档误导 |
| **P2** | 测试覆盖极低（无 API 集成测试） | 回归风险 |
| **P3** | 8 个 plugin 渠道在 Vercel 不可用但 UI 可能混淆 | 用户困惑 |

### 1.3 生产站点只读探测（2026-07-15）

| 检查项 | 结果 |
|--------|------|
| HTTPS + HSTS | ✅ `max-age=63072000` |
| CSP | ✅ 已配置（含 Turnstile） |
| X-Frame-Options | ✅ DENY |
| X-Content-Type-Options | ✅ nosniff |
| Referrer-Policy | ✅ strict-origin-when-cross-origin |
| 静态页 CORS | ⚠️ `Access-Control-Allow-Origin: *`（静态资源层） |

> **待授权项**：对 `/api/auth/login`、`/api/cron/*`、BOLA/IDOR 等需你确认后再做渗透测试（见第六节）。

---

## 二、通知渠道矩阵（Vercel 云端 30 个）

### 2.1 可用且已接入发送链（26 个）

**Webhook（8 专用 + 4 generic）**：discord, slack, feishu, wecom, dingtalk, synologychat, twitch, generic_webhook；googlechat/irc/matterbridge 走 generic。

**Token（18）**：resend, smtp, telegram, matrix, mattermost, nextcloud_talk, wxpusher, qmsg, serverchan, pushplus, bark, gotify, meow, pushme, wecomapp, ntfy, pushover, apprise。

### 2.2 已配置但未接入发送链（2 个）— 必须修复

| 渠道 | 状态 | 修复 |
|------|------|------|
| **line** | service 存在，分发链缺失 | 在 `index.ts` 增加 `sendLINENotification` 分支 |
| **msteams** | service 存在，分发链缺失 | 增加 `sendMicrosoftTeamsNotification` 分支 |

### 2.3 Vercel 明确剔除（8 个）

`wechat_personal`, `whatsapp`, `qq_bot`, `signal`, `imessage`, `zalo`, `clawbot`, `nostr` — 需长连接/本地进程，serverless 不可行。

### 2.4 建议新增渠道（调研后精选）

| 渠道 | 理由 | 接入方式 |
|------|------|----------|
| **PushDeer** | 国内轻量推送，HTTP API | 新增 service + config |
| **Chanify** | iOS/macOS APNs 网关 | HTTP API |
| **Lark 国际版** | 海外飞书用户 | 复用 feishu 逻辑 |
| **Webhook.site 兼容** | 调试友好 | 已有 generic |
| **Amazon SNS** | 企业级 SMS/Email | AWS SDK（可选） |
| **Twilio SMS** | 短信提醒 | REST API |
| **SendGrid** | 邮件备选 | 类似 Resend |
| **Mailgun** | 邮件备选 | REST API |
| **Discord 线程** | 已有 discord，增强 thread_id | 小改 |
| **企业微信应用消息增强** | 已有 wecomapp | 卡片模板 |

### 2.5 渠道自动可用性判断逻辑（待实现）

```
接入流程：
1. 用户填写配置 → Zod 校验字段完整性
2. 调用 POST /api/channels/test-connection（已有）
3. 新增：保存时自动 test + 写入 notification_accounts.health_status
4. 新增：定时健康检查 Cron（每日）重测 is_active 账户
5. 新增：发送前快速检查 last_health_check_at < 24h，否则先 test
6. 连续 3 次失败 → 自动禁用（已有）+ UI 标红 + 可选告警渠道通知
7. 前端 Channels 页：绿/黄/红 状态徽章 + 上次检测时间
```

---

## 三、批量邮件功能设计

### 3.1 需求

向指定用户或批量用户发送邮件（营销/通知/管理员广播），依托现有 Resend/SMTP 基础设施。

### 3.2 技术方案

| 组件 | 设计 |
|------|------|
| **API** | `POST /api/broadcast/email`（仅 admin 角色） |
| **收件人来源** | ① 手动输入邮箱列表 ② 按用户 ID ③ 按标签/分组 ④ 全站用户（需二次确认） |
| **发送引擎** | Resend Batch API（每批 ≤100 封）+ 队列分批 |
| **模板** | 复用 `templates.ts` + 新增 `broadcast` 类型 |
| **限流** | 管理员 10 次/小时；全站广播需 TOTP 二次验证 |
| **日志** | `email_logs` 表扩展 `broadcast_id`、`batch_index` |
| **退订** | 邮件底部退订链接 → `user_configs.email_opt_out` |
| **预览** | 发送前 `POST /api/broadcast/email/preview` |

### 3.3 Resend Batch 参考

- 端点：`POST https://api.resend.com/emails/batch`
- 每批最多 100 封；支持 `x-batch-validation: permissive` 部分成功
- Telegram 广播限流 ~30 msg/s，邮件无此硬限但需防垃圾邮件标记

### 3.4 前端页面

新增 `/broadcast` 或 Settings 子页：收件人选择器 + 模板编辑器 + 发送进度条 + 历史记录。

---

## 四、农历/公历换算验证计划

### 4.1 特殊时间点测试矩阵

| # | 场景 | 输入 | 预期 |
|---|------|------|------|
| 1 | 闰四月生日 | 农历 2020-闰4-15 | 公历 2020-06-06 |
| 2 | 腊月廿九/三十 | 小月年腊月廿九 | 不抛 `only 29 days` 错误 |
| 3 | 春节边界 | 除夕/正月初一 | 跨年调度正确 |
| 4 | 2月29公历 | 公历闰年生日 | 非闰年提醒策略 |
| 5 | 子时边界 | 23:00 vs 01:00 | 与固定 12:00 策略一致 |
| 6 | 双历 both | calendar_type=both | 公历+农历各提醒一次 |
| 7 | 2025 闰六月 | 农历六月 vs 闰六月 | isLeap 标志正确 |
| 8 | 时区 UTC+8 vs UTC-5 | 用户时区 09:00 提醒 | ±2min 窗口命中 |
| 9 | 跨年农历 | 12月创建，次年1月触发 | 当年/明年双试 |
| 10 | 不存在日期 | 农历 4-31 | 前端拦截 + 后端拒绝 |

### 4.2 修复项

1. `tasks.ts` 增加 `both` 分支（公历+农历各算一次）
2. 统一使用 `shared/lunar.ts`（消除 EventForm 内联重复）
3. 将 `test-lunar-*.mjs` 纳入 Vitest CI
4. 闰月生日策略可配置：仅闰年/每年平月/双庆祝

---

## 五、长期可用性保障（回答你的核心关切）

### 5.1 能否保证「一直能用」？

**诚实回答**：在 Vercel Hobby + 外部 Cron 架构下，**无法 100% 保证**，但可通过以下措施达到 **99.5%+ 可用性**（个人长期使用足够）：

| 风险 | 缓解措施 |
|------|----------|
| Vercel Cron best-effort 漏跑 | cron-job.org 每分钟 + Healthchecks.io 心跳 |
| Serverless 冷启动 | `/api/cron/warmup` + UptimeRobot 每 5min ping |
| 数据库连接耗尽 | Neon connection pooling + 连接复用 |
| 通知渠道故障 | 自动禁用 + fallback 渠道 + 告警 |
| 密钥泄露 | MASTER_KEY 轮换 + 审计日志 |
| 部署回归 | CI 测试 + 预览环境冒烟 |

### 5.2 通知及时性

- 当前：外部 Cron 每分钟 + ±2min 时间窗口 → **理论延迟 0–3 分钟**
- 改进：双 Cron 源（cron-job.org + EasyCron 备份）+ `cron_execution_logs` 监控
- 关键事件：事件创建后立即 `sendReminders()`（已有）

### 5.3 安全性 vs 性能

你的优先级（安全 > 性能）与项目现状一致。建议：
- HttpOnly Cookie 替代 localStorage JWT（P1）
- Passkeys/WebAuthn 补全（P2）
- 全站 Turnstile 强制（非可选）
- 安全事件实时告警到已配置渠道

---

## 六、安全审查计划

### 6.1 本地静态审查（无需授权，先做）

| OWASP API | 检查点 | 当前状态 |
|-----------|--------|----------|
| API1 BOLA | 事件/账户/日志是否校验 user_id | 需逐路由验证 |
| API2 认证 | JWT+Session 双校验 | ✅ 已实现 |
| API3 属性级授权 | 响应是否过滤敏感字段 | 需审查 |
| API4 资源消耗 | 限流+批量上限 | ⚠️ 部分有 |
| API5 功能级授权 | admin 路由保护 | 需审查 |
| API6 业务流 | 批量邮件/导出限制 | 待实现时加固 |
| API7 SSRF | url-safety.ts | ✅ 头像等 |
| API8 配置 | 默认密码、CORS、CSP | ⚠️ 默认密码需强制改 |
| API9 资产清单 | 遗留 cron 端点 | ⚠️ 多个 legacy 端点 |
| API10 第三方 | 通知 webhook 响应 | 需审查 |

### 6.2 生产渗透测试（需你授权后执行）

测试范围：`https://timemark.the37777777.top`

- [ ] 登录暴力破解 / 限流有效性
- [ ] Cron 端点无密钥访问
- [ ] CSRF 绕过（跨域 POST）
- [ ] IDOR：访问他人 event_id / account_id
- [ ] 分享链接 token 可预测性
- [ ] 敏感信息泄露（/api/config、错误堆栈）
- [ ] JWT 算法混淆 / 过期令牌
- [ ] 默认凭据 `admin/TimeMark@2026`
- [ ] Rate limit 绕过（X-Forwarded-For 伪造）
- [ ] SQL 注入（参数化查询审计）

**原则**：只读探测 + 低影响测试，不做 DoS/数据破坏。

---

## 七、可同搭的 10+ 配套服务

| # | 服务 | 用途 | 部署方式 |
|---|------|------|----------|
| 1 | **Healthchecks.io** | Cron 心跳监控 | SaaS 免费层 |
| 2 | **UptimeRobot** | 站点/API 存活探测 | SaaS 免费层 |
| 3 | **Sentry** | 错误追踪 + Cron Monitor | SaaS |
| 4 | **Apprise API** | 统一 150+ 渠道网关 | Docker/CF Worker |
| 5 | **ntfy.sh 自托管** | 通用推送 | Docker |
| 6 | **Gotify** | 带 UI 的推送服务器 | Docker |
| 7 | **Resend** | 事务邮件 + 批量 | SaaS（已集成） |
| 8 | **Cloudflare Turnstile** | 人机验证 | SaaS（已集成） |
| 9 | **Neon Postgres** | 主数据库 | SaaS（已用） |
| 10 | **GitHub Actions** | CI/CD + 备份 Cron | 已有 workflow 可扩展 |
| 11 | **Plausible/Umami** | 隐私友好分析 | 自托管 |
| 12 | **Grafana Cloud** | 指标/dashboard | 免费层 |
| 13 | **Bark Serverless** | iOS 推送 CF Worker | 参考 frankwei98/bark-serverless |
| 14 | **cron-job.org** | 分钟级提醒 Cron | 已文档化 |
| 15 | **Better Stack** | 日志聚合 | 可选 |

---

## 八、同类项目功能对标（GitHub 调研）

| 项目 | Stars | 可借鉴功能 |
|------|-------|------------|
| [BirthdayRS](https://github.com/wllzhang/BirthdayRS) | 198 | 干支/生肖/节气丰富信息、双历 |
| [birday](https://github.com/m-i-n-a-r/birday) | 1139 | 提前 21 天多级提醒、联系人导入 |
| [MIND](https://github.com/Casvt/MIND) | — | Apprise 80+ 渠道、秒级精度 |
| [Noted](https://github.com/dbwg2009/Noted) | — | AI 礼物推荐、愿望清单、iCal |
| [SharedMoments](https://github.com/tech-kev/SharedMoments) | — | Passkeys、里程碑倒计时、多版本 |
| [event-reminder](https://github.com/sivab193/event-reminder) | — | 队列邮件、PWA、时区智能 |
| [reminder-engine](https://github.com/gjivaros/reminder-engine) | — | 插件化渠道、K8s 部署 |
| timemark-docker（原版） | — | 43+ 渠道、Web Push、插件 |

**TimeMark 独有优势**：关系映射、祝福语模板、30+ 渠道、农历、Vercel 零运维。  
**明显缺口**：礼物/愿望清单、联系人导入、日历月视图、Passkeys、PWA、AI 辅助。

---

## 九、UI 模板参考（shadcn 生态）

当前项目已用 shadcn 风格组件。可参考升级：

| 模板 | 亮点 | 适用页面 |
|------|------|----------|
| [shadcn-admin](https://github.com/satnaing/shadcn-admin) | 侧边栏、全局搜索、暗色模式 | Dashboard 整体布局 |
| [next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter) | 数据表、图表、多主题 | Analytics、TriggerLogs |
| AdminCN | 50+ 页面、表单向导 | Channels 配置向导 |

**建议改造**（不改业务逻辑，只升 UI）：
1. Dashboard 卡片统计 → shadcn-admin 风格 stat cards
2. Channels 配置 → 分步向导（Step 1 选渠道 → Step 2 填凭证 → Step 3 测试 → Step 4 完成）
3. EventForm → 日期选择器增强（公历/农历 Tab + 闰月勾选）
4. 全局 Command Palette（⌘K 搜索事件/设置）

> Figma：可用 Figma MCP 将上述页面生成设计稿再对齐实现（需你提供 Figma 账号/设计系统）。

---

## 十、精选 40 项优化（高价值）

### 安全与可靠性（10）
1. 修复 LINE/Teams 发送链
2. 修复 `both` 双历调度
3. Cron 双源 + Healthchecks 心跳
4. 首次登录强制改默认密码
5. JWT 迁 HttpOnly Cookie
6. 补全 WebAuthn/Passkeys API
7. 全 API 路由 BOLA 审计
8. legacy cron 端点废弃或加鉴权
9. 安全事件 → 管理员渠道告警
10. `cron_execution_logs` 仪表盘

### 通知渠道（10）
11. 渠道健康状态自动检测
12. 统一 `channels.config.ts` 为唯一数据源
13. Google Chat 专用 API 替代 generic
14. IRC 专用 service 接入
15. 新增 PushDeer 渠道
16. 渠道配置分步向导
17. 测试连接结果持久化
18. 渠道失败原因中文化
19. Apprise URL 格式校验器
20. 静默时段与渠道优先级

### 功能补全（10）
21. 批量邮件广播模块
22. 日历月视图热力图
23. 冲突检测 UI 接入
24. iCal 订阅增强（双向）
25. 事件导入 CSV/联系人
26. 分享链接过期/密码
27. 提醒确认回执（已收到）
28. 多语言 i18n 框架
29. PWA 离线缓存
30. 插件渠道「仅 Docker」明确标注

### 代码质量（10）
31. 农历逻辑统一到 `shared/lunar.ts`
32. 发送链重构为 Strategy Map（消除 if-else）
33. Vitest 覆盖调度器+农历
34. Playwright E2E 核心流程
35. README 对齐 Vercel 实际架构
36. 删除未使用 stub/死代码
37. `migrate.ts` v16/v17 顺序修复
38. ESLint + Prettier CI 门禁
39. OpenAPI 文档自动生成
40. 类型严格模式 `strict: true` 全覆盖

---

## 十一、精选 60 项优化（扩展清单）

在以上 40 项基础上，增加：

### 体验与 UI（15）
41. Command Palette 全局搜索
42. 事件卡片骨架屏加载
43. 移动端底部导航优化
44. 暗色模式跟随系统
45. 动画过渡（Framer Motion 节制使用）
46. 空状态插画
47. 表单实时校验提示
48. 渠道图标 SVG 统一
49. 设置页分组折叠
50. 年度报告 PDF 导出
51. 拖拽排序事件优先级
52. 批量操作（删除/归档事件）
53. 快捷键（N 新建事件）
54. Toast 通知统一
55. 响应式表格 → 卡片列表

### 数据与分析（10）
56. 通知成功率趋势图（已有基础扩展）
57. 渠道使用排行
58. 用户活跃热力图
59. 提醒延迟分布直方图
60. 导出分析报告 JSON
61. 年度事件回顾自动生成
62. 关系映射使用统计
63. 登录地理分布地图
64. 失败原因 Top 10
65. 自定义报表日期范围

### 模板与内容（10）
66. 新增 20+ 节日模板（端午、中秋、七夕…）
67. 模板变量预览
68. 模板 A/B 测试
69. 祝福语按关系自动选择
70. Markdown 邮件模板
71. 渠道专属格式（Discord Embed、飞书卡片）
72. 模板市场（社区分享）
73. 多语言模板
74. 模板版本历史
75. 一键套用模板创建事件

### 运维与 DevOps（10）
76. GitHub Actions 自动部署预览
77. 数据库自动备份到 R2/S3
78. 环境变量检查 CLI 集成 CI
79. 蓝绿部署策略文档
80. 回滚一键脚本
81. 依赖漏洞 Dependabot
82. Bundle 大小监控
83. Serverless 冷启动指标
84. 日志结构化（pino）
85. 分布式追踪 OpenTelemetry

### 扩展功能（5）
86. Webhook 入站（外部触发提醒）
87. Zapier/n8n 集成
88. 公开 API + API Key（挂载已有中间件）
89. 多租户/组织（未来）
90. 礼品预算追踪（借鉴 Noted）

### 农历与文化（5）
91. 节气自动事件
92. 传统节日自动创建（扩展 lunar-holidays）
93. 生肖/星座展示
94. 农历倒计时组件
95. 闰月策略用户可选

### 测试与文档（5）
96. 渠道 mock 测试套件
97. 安全回归测试脚本
98. 部署视频教程
99. API Postman Collection
100. 贡献者指南 CONTRIBUTING.md

---

## 十二、分阶段实施路线图

### Phase 0：计划确认（当前）
- [x] 代码库审计
- [x] 联网调研（15+ 源）
- [x] 主计划文档
- [ ] 你确认优先级与渗透测试授权

### Phase 1：P0 缺陷修复（1–2 天）
1. LINE + Teams 发送链
2. `both` 双历调度
3. 渠道健康检测逻辑
4. 农历特殊点 Vitest
5. 统一渠道配置源

### Phase 2：安全加固（2–3 天）
1. 本地 OWASP 全路由审计 + 修复
2. 授权后生产渗透 + 修复
3. 强制改密 + Cron 心跳
4. legacy 端点清理

### Phase 3：批量邮件 + 配置简化（2–3 天）
1. Broadcast API + UI
2. Channels 分步向导
3. 模板丰富 + 预览

### Phase 4：代码规范化（2–3 天）
1. 发送链 Strategy 重构
2. 死代码清理
3. README/文档对齐
4. CI 测试门禁

### Phase 5：UI 升级 + 扩展功能（按需）
1. shadcn-admin 布局迁移
2. 日历视图、PWA、Passkeys
3. 新渠道 PushDeer 等

---

## 十三、调研来源索引

1. BirthdayRS / birday / MIND / Noted / SharedMoments / event-reminder / reminder-engine
2. Apprise 150+ 服务文档
3. Resend Batch API
4. Vercel Cron best-effort 官方文档
5. lunar-javascript 闰月 API
6. OWASP API Security Top 10
7. WxPusher / PushPlus / Server酱 2025–2026 文档
8. ntfy / Gotify / Bark API
9. Telegram Bot 限流
10. shadcn-admin / next-shadcn-dashboard 模板
11. Healthchecks.io / Sentry Cron Monitor
12. Hono 安全最佳实践
13. timemark-vercel 代码库审计
14. CHANNEL_COMPATIBILITY.md
15. OPTIMIZATION_PLAN.md

---

*下一步：请确认 Phase 1 是否立即开始，以及是否授权对生产站点进行渗透测试。*
