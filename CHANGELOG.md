# Changelog

## v2.22.0 (2026-10-01) — 最终发布（Waves 16-19）

> 标签计划：v2.22.0 为 Wave 18 之后的最终标签。
> 发布说明：本条目如实列出**已接入**的能力与**尚未接入 / 尚未实现**的项，不把「已实现但未接线」或未开工的功能当作已发布。

### 30 项扩展功能（Wave 16-18，已接入）

- **搜索与问答**：全局 `pg_trgm` 搜索（中文可用、零出网、命令面板）、Ask 面板（零 AI 的意图匹配 + 模板回答）
- **整理与治理**：跨实体标签（AND/OR 筛选）、去重助手（差异展示 + 显式合并 + 撤销）、批量操作（逐项结果）、撤销与审计轨迹、数据健康面板（安全一键修复）、迁移后结构自检
- **日程与表单**：今日一览（可配置卡片）、例程模板（幂等实例化）、历史智能默认（确定性、最小样本 3）、渠道故障修复向导
- **导入导出与本地能力**：外部 ICS / 只读 IMAP 订阅入库（含来源标签，不回写）、浏览器本地语音建事件（不上传音频）、可选 OCR（默认关闭）、打印 / 导出（本地渲染 HTML 再打印为 PDF，零出网）
- **共享与备份**：家庭只读分享（profile / tag / 清单维度，可选口令与过期）、加密的 WebDAV / S3 兼容备份（含保留策略与恢复记录）
- **中国日历与资讯**：进阶黄历（择日 / 八字 / 生肖配对，附免责声明）、天气与空气质量（Open-Meteo，无 key 静默降级）、包裹跟踪（承运商适配器 seam，默认桩）
- **其它**：考勤 / 工时、儿童与长者照护、宠物照护、车辆油耗与保养台账、观影 / 阅读清单、家庭库存共享、双向日历同步（冲突记录）、单 owner 家庭协作（非多租户）

### 提醒链路修复（Wave 19）

- 触发日志写入 `TEXT` 列，`提醒日志` 与失败计数真正生效；被跳过的提醒记录原因而非静默丢弃
- 错过一次提醒窗口后按需补发；手动测试发送回退到本人已配置渠道；生日 / 双历提醒修正
- 非法 IANA 时区在写入边界被拒绝，已存的非法值降级为 `Asia/Shanghai` 并告警

### 尚未完成的项（如实记录）

- **153-160 的后端模块已挂载，但前端缺页面**：照护 / 宠物 / 车辆 / 观影清单 / 双向日历同步 / 家庭协作的路由**已挂载**在 `backend/src/index.ts`（`/api/care`、`/api/pets`、`/api/vehicles`、`/api/watchlist`、`/api/calendar-sync`、`/api/collaboration`），接口可直接调用；缺的是前端页面与导航入口，界面上仍无法使用。考勤工时与家庭库存则确实尚未挂载。
- **161 字段级加密**已实现（`backend/src/services/field-encryption.service.ts`，附件文件名/内容类型已在用）。
- **168 联系人生日祝福**已实现（`birthday-greeting.service.ts`，由提醒 cron 调用）。
- **170 Wave 19 端到端验证：已执行**。`frontend/e2e` 全量 23 个 spec 在真实浏览器（`PLAYWRIGHT_CHANNEL=chrome`，本机已装 Chrome/Edge 时无需下载 Playwright 自带 Chromium）下跑完：**125 通过 / 7 失败**。这些用例自带有状态 API mock，只需要 Vite dev server，不需要真实后端或数据库。其中通知「延后」按钮覆盖了 access cookie 过期 → 换 refresh cookie → 重试一次且不重试成风暴的完整链路。
  7 条失败**均为既有问题，非本次改动引入**（已把 `sw.js` 与 `playwright.config.ts` 回退到 `ff17f04` 复跑，失败集合不变）：
  - `almanac.spec.ts` / `almanac-advanced.spec.ts`：断言「无 console error」，但页面有一个 404 资源（未定位到具体 URL；常见的 manifest / favicon / sw.js / search-index / icons 均实测 200）。根因未查明，如实记录。
  - `upgrade-smoke.spec.ts`：路由冒烟渲染断言失败。
  - `pwa-offline.spec.ts` 2 条：Chrome 对 dev server 报 installability error，`#timemark-install-banner` 不出现。
  - 另有 2 条（`basic.spec.ts` 未登录跳转、`task-90` RT1 Web Push）在 `--workers=1` 下通过，属并行执行时的偶发，不稳定但非功能缺陷。

## v2.21.0 (2026-09-30) — 后台 AI 运行时（Waves 14-15）

> 详见 [docs/BACKGROUND_AI.md](docs/BACKGROUND_AI.md)。

### 持久化作业运行时（F5）

- `agent_jobs` 持久化队列（迁移 `agent_jobs_v54`）：`SELECT ... FOR UPDATE SKIP LOCKED` + 租约 / 心跳 / 幂等键 / 30s 起、上限 6h 的指数退避 / 死信
- 有界领取与执行端点 `POST /api/agent/worker/drain`（默认一次 3 个，硬上限 50，响应预算默认 25s）
- 表驱动调度链：`scheduler_runs.next_run_at` + `POST /api/agent/scheduler/start`，默认 10 分钟一跳；不引入 Vercel Workflow 依赖，不需要常驻进程
- 触发拓扑：Vercel 内置 cron 仅每日一次；子日级由外部 cron-job.org 驱动；**无触发即零消耗**
- 模型分档 `lite` / `medium` / `high` 与逐作业成本护栏；每月 token / 调用预算按真实消耗评估
- 每日提醒预算（默认 3 条）、静默时段、6 小时去重窗口、60 分钟例程冷却
- 控制面 API 与「AI 后台」页面（作业 / Worker / 运行 / 成本 / 预算 / kill switch）与后台路径加固

### 主动但安静（F6）

- 早间简报、晚间复盘、周度复盘、每小时巡检例程（确定性优先，零模型调用）
- 批准 / 改 / 拒绝决策卡与可选「为什么」理由，进入持久偏好记忆并影响后续行为
- 无 AI 部署下的降级 / 离线 UX
- 可选**只出站**本地 Worker 协议与参考实现 `scripts/agent-worker.mjs`，见 [docs/WORKER.md](docs/WORKER.md)
- 运行观测（运行记录、成本账本、队列 / Worker 健康）与自看门狗（积压 / 连续失败 / 供应商错误，按窗口去重告警）

## v2.20.0 (2026-09-29) — 机器人、AI 层与日历 / 报告 / 目标（Waves 10-13）

### 日历与回顾（Wave 10-11）

- 中国日历增强：法定节假日 / 调休数据、农历 / 干支 / 生肖 / 星座 / 宜忌 / 节气卡片、节日感知提醒
- 周期性图文摘要（月 / 年）与设置页「立即发送」
- 目标与里程碑（迁移 `goals`）与「N 年前的今天」记忆卡
- 浏览器 Web Push 回归为一等渠道、PWA 可安装与离线安全
- CalDAV 只读订阅与可选回写、公开 ICS 订阅增强、分享 / 嵌入的 OG 元数据服务端渲染

### Telegram 双向机器人（Wave 12）

- `POST /api/bot/telegram` webhook：`X-Telegram-Bot-Api-Secret-Token` 常量时间校验、64 KB 上限、`update_id` 去重
- 命令调度器与中英别名表、内联键盘与幂等回调、chat/user/profile 链接与审计、MarkdownV2 转义与长度上限、不可信内容围栏与限流

### AI 与 Agent 层（Wave 13）

- OpenAI 兼容 AI 网关（primary / fallback / local、超时、重试、缓存、`decide()` 类型化决策、模型分档）
- 自然语言到已校验操作的解析器，默认规则模式、生成式路径可选
- Agent 工具注册表（单一事实来源 + 注册表哈希 pin）、scoped 可撤销令牌与调度时授权 + 审计、两阶段确认动作 API
- 无状态 Streamable HTTP MCP 服务器与只读资源（不可信内容围栏）
- 确定性行为模式挖掘（零 LLM）、`pg_trgm` 搜索（中文可用、零出网）与可选 embeddings（默认关闭）
- 本地模型支持（Ollama / LM Studio）与 [docs/AI.md](docs/AI.md)
- 可选 AI 摘要 / 事件打标 / 模板翻译（逐功能默认关闭，数字一致性护栏）
- 应用内助手（工具调用透明与确认）与 [docs/AGENT.md](docs/AGENT.md)

## v2.19.0 (2026-09-28) — 生活领域扩展（Waves 6-9）

- **D1 到期与续费中心**：订阅 / 账单 / 保险 / 域名 / 保修，费用聚合进入统计，多级提前提醒
- **D12 库存与保养**：库存数量 / 保质期 / 低库存阈值；按日期或用量计的保养计划
- **D2 文档保险箱**：护照 / 证件 / 驾照 / 签证 / 证书 / 保单，对象存储附件（迁移 `attachments` / `documents`），硬性大小与类型上限、短时签名 URL
- **D4 个人 CRM**：互动日志与联系节奏（迁移 `crm_interactions_cadence`），逾期联系人提醒
- **D6 习惯**：打卡与连续天数（迁移 `habits`），周视图
- **D5 家庭多档案**：profiles 模型并回填默认档案（迁移 `profiles`），列表与提醒按档案感知
- **D3 家庭用药**：剂量排程物化、打卡、库存递减、依从性与可打印报告（迁移 `medications` / `doses`）
- 数据导出 / 导入覆盖以上新实体

## v2.18.0 (2026-09-27) — 依赖现代化与遗留修复（Waves 4-5）

### 依赖大版本升级（一次一个 major，门禁全绿）

- React 19.3、Vite 8.3、Tailwind CSS 4.3（CSS-first 配置）、Zod 4.6、Vitest 5.0、TypeScript 7.0
- react-router-dom 7.18、zustand 5.0、recharts 3.10、framer-motion 13.4、resend 6.30、nodemailer 10.0、axios 1.20、hono 4.13

### 前端与 PWA

- Service Worker 安全化：新增 `CACHE_VERSION`，激活时清空全部缓存并 `clients.claim()`，导航请求仅走网络，不再缓存 HTML
- i18n：以 zh/en 懒加载资源加载器（`t(key, vars?)` / `useI18n` / `LanguageToggle`）替换 8 键 stub

### 稳定性与文档

- 修正会导致误判的文档 / 代码矛盾；校正通知重试队列描述（失败写入 `notification_queue`，5m/30m/2h/6h 退避，由 `/api/cron/retry-notifications` 处理）
- 通知路径 fire-and-forget 承诺与错误面加固；日志表增长上限与缺失索引补齐
- 请求关联的结构化日志与源头脱敏；既有页面的可访问性与响应式基线审计

## v2.17.0 (2026-09-27) — 渠道真相与清理（Waves 0-3）

### 工程门禁（Wave 0）

- CI 真门禁：typecheck + 单元测试 + lint + build（+ Playwright e2e），根 `lint` 脚本，tsconfig / `@types/node` 跨工作区对齐
- `.env.example` 补齐本计划引入的全部环境变量；Playwright 接入门禁并固定 base URL；记录改动前基线（测试数、构建体积、bundle 内容）

### 通知渠道（Wave 1-2）

- 修复渠道真相：`generic_webhook` 接入分发链；Pushover 连接测试不再把优先级当应用令牌；`twilio` / `wecomapp` / `apprise` 具备真实连接测试；每 provider 使用真实成功信号而非仅看 HTTP 状态；`channel-health` 复用同一测试路径；解析到无配置的渠道不再被静默吞掉；Synology Chat / Twitch 走专用 sender
- 新增 10 个 HTTP 渠道：Server酱³ (SC3)、息知 (XiZhi)、AnPush、Chanify、Pushback、SimplePush、Zulip、Rocket.Chat、Firebase 推送 (FCM HTTP v1)、Twilio WhatsApp
- **云端可用渠道 42 个（webhook 11 · token 31）**，由 `scripts/gen-channel-matrix.mjs` 生成 [docs/CHANNEL_MATRIX.md](docs/CHANNEL_MATRIX.md) 作为唯一权威清单；渠道元数据合并为 `channels.config.ts` 单一数据源，README / 兼容性文档的计数与生成值一致

### 清理（Wave 3）

- 删除 9 个死 IM 服务与 Vercel stub；移除 `baileys` / `oicq` / `wechaty` / `@tencent-weixin/openclaw-weixin` 等 exotic 依赖与 `blockExoticSubdeps=false` override；新增「无死渠道代码」仓库不变量测试

## v2.16.0 (2026-07-31)

### 双历与农历

- **事件表单**：公历/农历/双历模式正确同步 `lunarDate`；纯农历使用农历文本输入；保存时往返校验
- **倒计时与待办**：前端 `resolveNextOccurrenceDate` 支持农历/双历，与 Cron 提醒逻辑对齐
- **日历页**：事件标签显示「公历 / 农历 / 双历」
- **自检**：`runLunarCalendarSelfTest` 公历→农历→公历往返校验（`shared/lunar-calendar`）

### 时区与 NTP 时间校准

- **默认时区**：`Asia/Shanghai`（北京时间）；首页快捷切换与设置页全局联动
- **NTP 校准**：Cron 提醒、`/api/time/status` 使用 WorldTimeAPI / timeapi.io 校正时钟漂移
- **按用户时区**：切换时区后 NTP 与「今天」计算跟随该 IANA 时区
- **首页时钟**：接入 NTP 偏移后的校正时间
- **健康检查**：`/api/health` 不再阻塞等待 NTP；Cron 详情仅 `detailed=1` + token 可见

### 登录性能

- Turnstile、IP 封禁、账户锁定 **并行检查**
- 登录查询 **合并为一次**（密码 + TOTP + IP 白名单 + 改密状态）
- 无失败记录时跳过 `countPasswordFailuresSinceLastSuccess`
- 成功路径：先返回 Session，审计日志 **后台异步**
- `/api/auth/login` 不再重复走全局 `apiRateLimit`
- Turnstile **preconnect** 预连接 Cloudflare

### 安全加固

- **零信任**：移除未验证的 `X-API-Key` bypass
- **Passkey 登录**：与密码登录一致，强制 Turnstile 人机验证
- **外部日历 SSRF**：拉取 ICS 前 `isSafePublicUrl()` 校验
- **Resend Webhook**：生产环境一律要求有效签名
- **Google OAuth**：回调重定向限制在白名单域名（`CORS_ORIGIN` / canonical）
- **API Key**：移除 `api_key` 明文回退，仅 `api_key_hash`

### 单用户模式

- 固定个人单账户，禁止创建第二用户
- 会话令牌后台自动续期；安全中心移除需手动改 Vercel env 的 MASTER_KEY 轮换 UI

### 提醒修复

- Cron 纳入无 `user_configs` 但有事件的用户；登录/bootstrap 自动补配置
- 修复 `nextOccurrence.slice is not a function`（pg DATE 兼容）
- 提醒时刻 ±2 分钟窗口抽取为 `matchesReminderTimeWindow` 共享函数

### 文档

- 更新 README、CHANGELOG、SECURITY_AUDIT、OPTIMIZATION_PLAN、TURNSTILE_SETUP、INTEGRATIONS、NOTIFICATIONS

## v2.15.0 (2026-07-17)

### 固定联系人

- **多联系方式**：每个联系人支持多个邮箱、手机、Telegram / QQ / WxPusher，带标签（如「工作」「妈妈」）
- 数据模型：`fixed_contacts.contact_methods` JSONB（迁移 **v30**），旧单字段自动迁入
- **快捷发信**：仅 1 个邮箱直接进入编辑；多个邮箱先进入二级界面手动勾选（默认不全选）
- **批量邮件 / 事件提醒**：选中联系人时自动合并其全部邮箱
- API：`POST/PUT /api/contacts` 支持 `emails`/`phones` 等数组；`recipientEmails` 可指定子集

### 近期待办

- **打勾完成**：`/todos` 与首页待办同步服务端 `todo_completions`（迁移 **v29**）
- **自动移出**：事件过期或离开提醒窗口后从当前列表隐藏
- **完成历史**：「完成历史」标签页查看已归档记录
- **定期清理**：`daily-maintenance` 删除 `occurrence_date` 超过 365 天的完成记录

### 日历

- 年 / 月 / 日视图切换；日期格子可点击；默认展示本月事件列表

### 安全加固

- **发信白名单**：`POST /api/contacts/:id/send-email` 的 `recipientEmails` 必须属于该联系人，修复开放邮件中继风险
- **API 密钥脱敏**：`GET/PUT/POST /api/config/accounts` 响应不返回明文 `token`/`secret`，以 `tokenConfigured` 等标志代替
- **HSTS**：应用层与 `vercel.json` 增加 `Strict-Transport-Security`
- **SMTP TLS**：587 端口 `requireTLS: true`
- **CORS**：禁止 `CORS_ORIGIN=*` 与 credentials 组合
- 快捷发信写入 `email_logs` 时附带 `user_id`

### 文档

- 更新 README、SECURITY_AUDIT、NOTIFICATIONS、OPTIONAL_FEATURES、OPTIMIZATION_PLAN
- 部署自检期望 schema 版本 **v30**

## v2.14.3 (2026-07-15)

### 修复
- **登录 Turnstile**：修复 `execute` 模式下验证回调使用陈旧闭包，导致用空用户名/密码提交并显示 `Invalid input`
- 改为页面加载时显示可见 Turnstile 组件；验证完成后可自动登录
- **Turnstile 显示**：去除卡片 `overflow-hidden` 与 motion 透明动画包裹；增加 `.turnstile-host` 底色边框；`appearance: always`；回调 ref 可靠挂载

## v2.14.2 (2026-07-15)

### 体验与文档
- **深浅色切换**：View Transitions API 圆形扩散动画（从点击位置向外过渡；尊重 `prefers-reduced-motion`）
- **深色模式对比度**：调高 muted 文字、边框与玻璃面板可读性
- 新增 [docs/OPTIONAL_FEATURES.md](docs/OPTIONAL_FEATURES.md)：平台 env、通知渠道、集成、Cron 均可选说明
- 通知渠道页与文档强调「按需绑定，不配置不影响核心功能」

## v2.14.1 (2026-07-15)

### 文档与可选集成
- 新增 [docs/GOOGLE_CALENDAR_OAUTH.md](docs/GOOGLE_CALENDAR_OAUTH.md)：Google OAuth 可选配置、Vercel 环境变量、Google Cloud 重定向 URI、schema v27
- 更新 VERCEL_DEPLOYMENT、FREE_TIER_DEPLOY、INTEGRATIONS、README：schema 期望版本 v27；Google OAuth 标明为可选
- 设置页：未配置 OAuth 时显示中性提示（不影响其他功能），链至集成文档
- 部署自检 `EXPECTED_SCHEMA_VERSION` 更新为 27

## v2.14.0 (2026-07-15)

### Phase 0 — 收件箱
- 完成 inbox 全链路：迁移 v23、路由、CSRF 豁免、通知成功写入收件箱、30 天清理、前端 Inbox 页与未读角标

### Phase 1 — 优化项 B1–B40
- 数据库连接池、pooler 检测、防重提醒、事件缓存增量刷新、prefetch、ICS ETag、批量 LIMIT 50、邮件合并、Turnstile、Webhook 幂等/限流、MASTER_KEY 轮换 API、CSP report-uri、Cron 监控、健康检查队列深度、stats_daily 聚合、测试与 i18n/PWA 等

### Phase 2 — 功能 C1–C40（排除 AI/多租户/分享/热力图/市场）
- CalDAV 同步、VALARM、多 feed token、条件规则、联系人分组、集成文档、出站 webhook、年报渠道成功率、Passkey 登录、加密备份、Cron 前端页、嵌入倒计时等

### Phase 3 — Serverless 适用性
- `serverless-suitability.ts` + `/api/features/serverless-check` 文档化需外部 cron 的功能

### 安全
- 安全审查修复：Webhook 载荷限制、HMAC 验证、审计日志、幂等键

## v2.13.0 (2026-07-15)

### 通知系统修复与完善

- **渠道测试 Validation failed**：`testConnectionSchema` 支持仅传 `accountId`；统一收件人回退逻辑
- **渠道状态显示**：不再对所有启用渠道假显示「已连接」；按已验证/未测试/失败/禁用分组
- **Resend 渠道**：恢复「收件人邮箱」字段；编辑表单通用回填；测试失败返回 HTTP 400 与明确错误信息
- **设置页**：「通知默认邮箱」可保存与清空；近 30 天「邮件记录」
- **测试发送**：`test-send` 写入 `event_trigger_logs`；渠道测试传递 `accountId` 并持久化 `last_test_result`
- **失败重试**：`notification_queue` 指数退避（5m→30m→2h→6h）；Cron `/api/cron/retry-notifications`

### 集成功能（Migration v22）

- **入站 Webhook**：`POST /api/webhook/receive/:token` 创建事件，可选 HMAC 签名
- **日历 ICS Feed**：`GET /api/calendar/feed/:token.ics` 供 Google/Outlook 订阅
- **外部 ICS 同步**：设置页配置 URL + Cron `/api/cron/calendar-sync`
- **冲突提示**：通知正文追加同日其他日程提示
- **事件缓存**：`event_reminder_cache` 表（PostgreSQL，非 Redis）
- **年度报告**：月度热力图与 `year` 查询参数

### 部署与自检

- **部署向导**：中文系统自检、数据库结构版本（v22）、区分平台 env 与渠道 API Key
- **Turnstile**：兼容 Vercel 中 `SecretKey` / `SiteKey` 命名
- **登录限流**：仅 `POST /login` 限流，避免全 `/api/auth/*` 误触 429

### 文档

- 新增 [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)、[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)
- 更新 README、VERCEL_DEPLOYMENT、FREE_TIER_DEPLOY 中的 Cron 与 Resend 说明

## v2.7.0 (2026-07-15)

### 云端通知渠道精简

- **移除不可用渠道**：微信个人号、WhatsApp、QQ Bot、Signal、iMessage、Zalo、Clawbot、Nostr 从前端 UI、API 路由和发送逻辑中完全移除
- **仅保留 HTTP 渠道**：Webhook / Token 类（飞书、钉钉、Telegram、邮件、Bark 等 30+ 渠道）
- **服务端校验**：创建/测试通知账户时拒绝不支持的渠道类型（`supported-channels.ts`）
- **前端清理**：移除「插件」Tab、扫码授权弹窗、浏览器 Web Push 设置项
- **Vercel 构建**：恢复真实 HTTP 通知发送，仅 stub 已移除的 IM 服务模块

### 安全

- 登录失败锁定与限流机制保持不变，**不提供运维解锁脚本或后门**
- 锁定按用户名跨 IP 生效，防止换 IP 暴力破解
- 登录 429 响应显示剩余锁定时间
- 移除 `scripts/clear-login-lock.ts`；认证接口限流收紧为 10 次/分钟

### 文档

- 更新 README、VERCEL_DEPLOYMENT、CHANNEL_COMPATIBILITY 等文档以反映云端可用渠道列表

## v2.6.0 (2026-05-31)

### 安全加固
- 移除硬编码默认密码和 MASTER_KEY，首次启动自动生成随机密码
- 密钥迁移机制（向后兼容旧密钥加密数据）
- CSRF 中间件加固 + 分层 Rate Limiting + 安全响应头
- 所有 API 端点添加 Zod 输入验证
- 删除 14 个开发测试脚本

### 稳定性
- ClawBot/OpenClaw 扫码登录修复
- 插件 Session 持久化到 SQLite
- 断连检测 + 自动重连 + 通知失败反馈和重试

### 通知渠道
- 43 个渠道依赖审计 + 兼容性矩阵
- 渠道绑定逻辑（只有已配置渠道可选）
- 重量级插件移至 optionalDependencies
- 通知降级策略 + ServerChan3 新 key 兼容

### 性能优化
- Docker 多阶段构建（镜像减小 30%+）
- pino 结构化日志

### 功能增强
- 新增 7 个事件类型专属通知模板和祝福语
- 渠道状态 API + 调度器状态 API

## v2.4.2 (2026-05-04)

### 新增功能

- **通知预览按事件类型分组**: 创建事件时，通知预览会根据选择的事件类型显示对应的模板，而不是显示所有模板
- **事件类型模板映射**: 每种事件类型（生日、考试、纪念日等）都有专属的模板列表

### 验证

- **定时邮件发送功能**: 已验证自动触发功能正常工作，邮件成功发送到用户邮箱
- **测试按钮功能**: 已验证测试按钮可以正常发送邮件

## v2.4.1 (2026-05-04)

### Bug 修复

- **[严重] Resend 发件人邮箱字段强制必填**: 将发件人邮箱字段改为可选，支持使用已验证域名的任意邮箱地址
- **[严重] Zod 验证失败**: 修复 webhook 字段验证规则，允许 URL 或邮箱地址格式
- **[一般] 调度器时间匹配**: 将调度器频率从每15分钟改为每分钟，更精准的提醒时间匹配
- **[一般] 事件创建后立即触发**: 事件创建和更新后立即检查是否需要发送提醒

### 优化

- **Resend 发件人邮箱**: 支持使用已验证域名的任意邮箱地址（如 noreply@email.the37777777.top）
- **默认值更新**: 留空时使用 Resend 测试地址 onboarding@resend.dev（仅能发送到自己的邮箱）
- **调度器触发机制**: 事件创建/更新后立即触发提醒检查，确保不会错过即将到来的提醒时间

## v2.4.0 (2026-05-04)

### 新增功能

- **通知模板预览**: 创建事件时可预览通知内容，支持 6 种预设模板
- **自定义事件模板**: 支持创建自定义模板（如驾照到期、保险续费），可在"其他"类型下选择
- **浏览器推送 UI**: 设置页面添加浏览器推送通知开关
- **日历导出按钮**: Dashboard 头部添加 ICS 导出按钮
- **重复事件选项**: EventForm 添加重复事件开关（每天/每周/每月/每年）
- **更多事件类型**: 新增会议、截止日期、旅行、毕业、婚礼、医疗等类型
- **关联人员优化**: 添加说明文字和提示信息
- **称呼转换规则**: 扩展到 40+ 常用称呼映射
- **CSRF 保护**: 添加 Origin/Referer 头部验证中间件
- **API 分页**: 事件列表支持 page 和 limit 查询参数
- **单元测试**: 添加核心功能测试（关系映射、模板、祝福语）

### Bug 修复

- **[严重] 设置页面白屏**: 添加 CalendarClock 导入修复
- **[严重] 提醒时间不生效**: 调度器支持 reminderTimes 数组（15分钟窗口匹配）
- **[严重] 自定义时间不生效**: 修复前端自定义时间保存逻辑
- **[严重] 倒计时显示错误**: 修复基于事件日期而非提醒时间计算倒计时
- **[严重] iMessage 渠道**: 改为 BlueBubbles 服务器配置
- **[一般] IRC 占位符**: 修正为正确的 IRC 桥接 URL 示例

### 优化

- **TypeScript 类型**: 添加 EventRow、UpdateEventData 接口替代 any 类型
- **Zod 验证**: 添加 config.schema.ts 验证通知账户配置
- **通知渠道字段**: 保持向后兼容，优化标签说明

## v2.3.0 (2026-05-04)

### 新增功能

- **自动生成密钥**: 首次启动自动生成随机 JWT_SECRET 和 MASTER_KEY，保存到 `data/.env`
- **更多示例事件**: 新增妈妈生日、结婚纪念日、女儿生日、驾照到期、中秋节等示例

### Bug 修复

- **[严重] 渠道测试按钮**: 修复 configMethod 字段名不匹配导致测试失败
- **[严重] 事件测试发送**: 修复 notification_channels JSON 解析问题
- **[严重] Resend 发件人**: 使用账户配置的发件人邮箱代替硬编码值
- **[严重] 时区偏移**: 修复 new Date() 解析 YYYY-MM-DD 为 UTC 导致的 8 小时偏移
- **[一般] IRC 占位符**: 修正为正确的 IRC 桥接 URL 示例

### 文档更新

- **README.md**: 更新环境变量说明，添加密钥管理说明
- **DEPLOYMENT.md**: 更新部署指南，说明自动生成密钥功能

## v2.2.0 (2026-05-02)

### Bug 修复

- **[致命] sql.js 防抖保存**: 写操作后不再立即全量导出数据库，改为 2 秒防抖，性能提升 10-50x
- **[致命] SIGTERM 信号处理**: 统一信号处理，避免双重 exit 导致数据丢失
- **[致命] 农历时区错误**: 使用 UTC 构造 Date 对象，避免跨时区日期偏移
- **[严重] 通知重试机制**: 发送失败自动重试 3 次（1s/2s/4s 指数退避）
- **[严重] COALESCE 修复**: 用户配置现在可以正确清空字段为 null
- **[严重] chat_id 加密**: 通知账户的 chat_id 字段现在也经过 AES 加密存储
- **[严重] bcrypt 异步化**: 密码哈希改用异步 API，不再阻塞事件循环
- **[严重] 通知超时**: 所有通知渠道 HTTP 调用添加 10 秒超时
- **[严重] 硬编码密钥检测**: 启动时检测默认 JWT_SECRET/MASTER_KEY 并输出警告
- **[一般] 提醒去重**: 同一事件同一天不会重复发送通知
- **[一般] reminder_time 检查**: 只在事件设定的提醒时间（小时）发送通知
- **[一般] 限流器内存泄漏**: 添加 store 大小上限 + timer.unref()
- **[一般] 登录锁定增强**: 添加基于用户名的全局锁定（防止不同 IP 绕过）
- **[一般] 密码强度统一**: 登录和修改密码统一要求最少 8 字符
- **[一般] 类型修复**: login_logs 删除使用 parseInt 转换 user.id

### 安全加固

- **非 root 容器运行**: Dockerfile 添加 `USER app`，容器以非 root 用户运行
- **密钥启动检测**: 启动时检测并警告默认密钥
- **CORS 可配置**: 支持 `CORS_ORIGIN` 环境变量

### 性能优化

- **sql.js 防抖保存**: 写操作后 2 秒防抖，避免频繁全量导出
- **bcrypt 异步**: 密码哈希不再阻塞事件循环
- **镜像优化**: pnpm 改用 corepack 安装，镜像体积减小

### 新增功能

- **请求 ID 追踪**: 每个请求自动生成唯一 ID（X-Request-ID）
- **结构化错误码**: 定义统一错误码体系
- **统计 API**: `GET /api/stats` 返回事件统计、通知成功率、渠道使用情况
- **备份 API**: `GET /api/backup/export` + `POST /api/backup/import`
- **CSV 导入**: `POST /api/events/import-csv` 批量导入事件
- **API Token 认证**: 支持 `X-API-Key` 头进行 API 认证
- **农历智能节日提醒**: 自动为用户创建春节、中秋等农历节日事件
- **数据库迁移版本控制**: 支持增量迁移，跟踪 schema 版本
- **通知队列表**: 新增 `notification_queue` 表，为未来持久化重试做准备

## v2.1.0 (2026-04)

- 新增 8 个通知渠道（ClawBot/Server酱/PushPlus/Bark/Gotify/喵推送/PushMe/企微应用）
- 邮箱多账号选择
- 登录锁定线性叠加
- Docker 依赖修复
- 零配置即开即用

## v2.0.0 (2026-04)

- 架构重构：PostgreSQL + Redis → SQLite 单容器
- 零配置即开即用
- 登录锁定 + 安全告警 + 登录日志
- 通知凭证 AES 加密
- 触发日志

## v1.1.1 (2026-04)

- 登录锁定、UI 优化

## v1.1.0 (2025-04)

- 提醒多选、农历修复

## v1.0.0 (2025-01)

- 初始版本
