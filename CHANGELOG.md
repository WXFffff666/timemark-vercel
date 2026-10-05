# Changelog

## v2.26.0 (2026-10-05) — 祝福链修复 + 日志保留 + UI 合并 + 全站动画

### 批次 A：祝福链修复（v80 前置）

- **邮件送达性头**：sendRawEmail 双栈（Resend + SMTP）统一附加 Reply-To / List-Unsubscribe（mailto: + https 双写）/ List-Unsubscribe-Post / Message-ID——对齐 Gmail/Yahoo 批量发件人新规，降低被拦截概率。
- **预演所见即所发**：`/greetings/preview` 改走 `composeFinalGreeting` 单入口（此前预演用组合引擎、真发可能走 AI，两者可能不一致）；历史记录带 source（AI 生成/组合引擎）徽章。
- **AI 预算闸**：日上限 20 条（超限回落组合引擎，调用方无感）；每 cron tick 上限 5 条 AI 生成。
- **语气选项**：AI 祝福支持语气要求；设置页单条「AI 预览」按钮（POST /greetings/preview-ai）。

### 批次 B：日志保留与 AI 归档（迁移 v80）

- **18 张日志表全部有界**：此前从未清理过的 13 张表（reminder_send_claims、scheduler_ticks、audit_events、audit_undo_snapshots、security_events、audit_logs、bot_updates、bot_audit_logs、webhook_idempotency_keys、feed_ingest_seen/proposals、greeting_history、cron_execution_logs）补上保留期（30–1095 天按表分级）；runner 单表失败不拖垮整体。
- **cron 日志有界化**：成功路径改 `cron_job_status` upsert（每 job 恒一行，含 last_summary/duration），替代此前每分钟一条的无限增长；失败才写 `cron_execution_logs` 明细（30 天清理）。`/api/health` 与 `/api/cron-monitor` 改读有界表。
- **AI 月报归档**：digest 发送前正文（AI 叙述或确定性统计）写入 `digest_archive` 永久保存——原始触发日志 90 天后清掉，AI 提炼的"重要的东西"留下来。
- **慢查询治理**：event_trigger_logs / cron_execution_logs 加窗口与索引（idx_cron_executed_at、idx_trigger_user_created）；patterns 服务查询加 90 天窗口。
- **设置页数据管理卡**：保留策略展示 + 「立即清理」（与 nightly 同一代码路径）+ AI 月报归档列表（GET/POST /api/retention）。

### 批次 C：UI 合并（功能重合去重）

- **删除 /assistant 页**：AssistantDock 已全局承载同一面板，独立页是第二个入口——删页，dock 成唯一入口。
- **/reminders 并入 /trigger-logs**：两页展示的是同一类数据（事件提醒投递历史）且共用 readDelivery 判定——Reminders 列表抽取为 `EventReminderLogs` 组件成为「事件提醒」tab（`?tab=reminders` 可深链），旧链接 301 重定向；底部栏主位直接指向合并页。
- **联系人快捷发信 → Broadcast 深链**：快捷发信弹窗与「批量邮件」功能重合——按钮改深链 `/broadcast?contact=<id>`，Broadcast 预选该联系人并消费 query；两套写信 UI 归一。
- **命名修正**：导航「通知模板」→「事件模板」（页面本就自称事件模板）；「问答」→「智能问答」。
- **导航不变式更新**：nav-groups 测试新增 REDIRECT_ROUTES 集合（重定向兜底路由不需要入口）。

### 批次 D：全站动画与滚动治理

- **页面过渡真正生效**：Routes 包 AnimatePresence(mode='wait') + keyed motion 包装——此前各页根元素写好的 exit= 全是死代码（Routes 没有 AnimatePresence 退出动画从不执行）；路由层统一过渡一次覆盖 28+ 页；/login 与 embed/share 跳过；AppRoutes 显式固定 location，退场树不会跳变到新路由内容。
- **弹层补动画**：AssistantDock 面板、CommandPalette、MobileBottomNav「更多」抽屉此前都是无动画条件渲染——补出场/退场 motion（抽屉 spring 上滑、面板 fade+scale）。
- **滚动穿透治理**：全站 17 处内部滚动容器（弹窗、抽屉、面板、列表）补 `overscroll-contain`——弹层内滚到底不再拖动整页。
- **LocalAI 对话滚动修复**：`scrollIntoView` 会滚动所有可滚祖先（整页）导致发消息后页面跳走——改为只滚对话容器自身 `container.scrollTop`。
- **PWA 安装浮层「稍后」记忆**：dismiss 后 7 天内不再弹（此前每次加载都弹）。

### 批次 E/F：AI 增强

- **周报 AI 综述（首个真实 AI 消费者）**：确定性周报之上加 2-3 句 AI 综述——每周每用户至多 1 次、maxTokens 220、lite tier，AiDisabledError/失败/空清单退回与纯确定性渲染逐字节一致的原文；usage tokens 计入 costTokens；narrate 可注入（回归测试 3 例）。
- **本地 AI 会话持久化**：对话历史存 IndexedDB（快照式、上限 100 条、来源徽章一并恢复），刷新/重进不丢；「清空对话」按钮。
- **快捷指令**：LocalAI 空态提供 4 个常用问法一键填入。
- **礼物建议**：祝福草稿工具新增「礼物建议」——本地 WebGPU 按关系/备注生成 3-4 个带价位建议（数据不出本机）。
- **生日前 3 天准备提醒**：生日事件默认注入 d3 提醒（用户已配置 d3 则不重复注入）。
- **docs/AI.md**：Vercel GPU 专项调研结论（运行时不占构建分钟核实无误 / GPU 仅 beta+Pro / CPU 生成式推理实测不可用）+ AI 消费者与预算总表。

### 验证记录

- 后端 1664 / 前端 308 测试全绿；双端 tsc 干净；vite build 通过
- v80 干净库迁移验证（docker postgres:16-alpine）：schema_version=80，cron_job_status（含 last_summary）/ digest_archive / greeting_history.source,tone / 新索引全部就位
- Playwright 真浏览器实测：登录 → /reminders 重定向与 tab → /assistant 删除+dock 全局 → 设置页数据管理卡（真调 purge-now）→ Broadcast ?contact= 深链预选 → 联系人快捷发信深链 → LocalAI 快捷指令 + WebGPU 本地问答端到端 + 会话持久化（刷新恢复）→ 命令面板开合，全程无 console error
- Mimosa 深度扫描后台执行（git-gate advisory 提示的完整审计补课）

## v2.25.0 (2026-10-05) — 无审查本地模型 + AI 定时生日祝福

### 新增（功能 30 项，编号后括注验证方式）

**本地模型多档化（批次 A）**
- **三档模型选择器**：轻快档 0.5B（278MB，内置直发秒开）｜强力中文档 Qwen3-1.7B（944MB，在线获取）｜无审查档 Hermes-3-Llama-3.2-3B（1.7GB，Nous Research 微调，在线获取）。UI 选档 + localStorage 记忆（单测 16 例 + vite build + 真浏览器）。
- **在线获取档**：两档最大分片 155/197MB 超 GitHub 单文件 100MB 硬限（实测），改为不入库不进构建产物——UI 一键下载 → hf-mirror 流式拉取 → IndexedDB 永久缓存后离线；wasm kernel（~5MB）入库同源托管（raw.githubusercontent 国内不可达）。
- **契约全部实测**：sha256 来自 HF tree API lfs.oid / 知屋 contracts，零手写值。
- 切档自动卸载旧引擎释放显存（WebGPU）。

**AI 定时生日祝福（批次 B，迁移 v79）**
- **祝福组合引擎**（`shared/greeting-composer.ts`）：开头×主体×结尾×关系维度组合，按 contactId+year 确定性轮换——同人每年不重文、预演所见即所发、纯函数零依赖（单测 7 例）。
- **AI 双路生成**：配了 AI 网关时按联系人上下文（称呼/关系/性别/备注）生成个性化祝福（lite tier + sanitize-html 清洗），未配/失败自动回落组合引擎——祝福永远发得出去。
- **自动/草稿双模式**：自动=当天 cron 生成并直发；草稿=进待确认列表一键发送（设置页开关）。
- **生日祝福设置卡**：模式/AI 开关 + 未来 30 天预演（每人日期+主题+退订标记）+ 草稿发送/丢弃 + 今年已发计数。
- **greeting_history 表**：谁/哪年/渠道/最终文案——轮换依据 + 审计 + 草稿暂存。
- **联系人生日字段**（fixed_contacts.birth_date）：没建生日事件的联系人也能触发祝福；联系人表单加生日与「退出祝福」开关。
- **/api/greetings 路由**：settings/preview/history/send-draft/discard-draft/channels-check（路由测试 9 例）。
- **本地 AI 写祝福工具**：/local-ai 页选联系人→本地 WebGPU 生成→复制（数据不出本机）。
- **防拦截组合拳**：每人每年内容唯一 + 发信白名单（仅联系人，复用 sendContactEmail）+ 送达性头链路 + 无外链图片 + 联系人级退订 + 每年幂等（claim + history 双闸）。

**其他新功能（批次 C）**
- **静默时段横幅**：Dashboard 在静默窗口内显示"提醒会窗口结束后补发，不会丢失"（支持跨午夜窗口）。
- **渠道修复向导接入**：暂停徽章旁新增「🔧 修复」——诊断→换凭据→重新启用的完整向导（组件已存在但从未挂载，现已接线）。
- **blessings 扩池**：birthday 14→24 条、anniversary 7→12 条，加现代语气变体。
- **祝福语确定性轮换**：getBlessing 从 Math.random 改为按 (类型+人+当天) 哈希——同天同人不重复、跨天轮换、可复现。
- **命令面板快捷入口**：空态新增 本地 AI / 通知渠道 / 提醒日志 直达按钮。
- **渠道统计导出 CSV**：按渠道+按账户两段，带 BOM（Excel 中文不乱码）。
- **提醒日志渠道徽章图标**：✓ email 前显示该渠道真实图标。

### 优化（30 项，已落地 22 项）

1. WebLLM 引擎单例 → Map<tier>（知屋模式）；2. RAG 提示词/生成参数按档位化（0.5B 硬约束防跑飞，大模型放宽）；3. 切档释放旧引擎显存；4. LocalAI 模型文案去硬编码；5. 内置权重就绪探测只测 bundled 档（remote 档不做无意义 HEAD）；6. AI 输出 sanitize-html 强制接入；7. AI 祝福走 lite tier（低成本槽）；8. 祝福幂等双闸（claim + history）；9. 预演用 composer 确定性输出（不真调 AI，省时省钱）；10. greeting 发送失败释放 claim 供重试；11. TriggerLogs 图标缓存单飞；12. Contacts 表单状态新增 birthDate/greetingOptOut 直通 payload；13. 命令面板空态可操作化；14. 静默窗口解析容错（畸形值不渲染）；15. 统计 CSV 转义/转 BOM；16. 迁移链测试尾 pin 全量更新至 v79（migration-versions 重新生成）；17. 迁移链注释同步（74→75 注册数）；18. selfcheck ahead 测试用例前移一位（80）；19. vitest mock 补齐 templates 分支（TriggerLogs）；20. 渠道页统计卡与 fetchStats 联动修复向导完成后的刷新；21. shared 重建后类型即时对齐（birthDate/greetingOptOut 推导）；22. eslint/tsc 全绿贯穿。

**未完成（如实记录，建议下轮）**：祝福投递的非邮件渠道（联系人 telegram/qmsg/wxpusher 字段已有但投递未接）、通知规则时间线、本地 AI 会话历史持久化、Web Push 设备管理页、联系人生日 CSV 批量导入、数据健康"生日联系人缺邮箱"检查项、年度报告祝福回顾、greeting cron 分批预算。

### 验证记录

- 后端 1661 / 前端 308 测试全绿；双端 tsc 干净；vite build 通过
- v79 干净库迁移验证：schema_version=79，4 个新列 + greeting_history 表就位
- Hermes-3/Qwen3-1.7B 契约来自 hf-mirror tree API 实测（65/37 文件，sha256 全对齐）

## v2.24.1 (2026-10-05) — 本地 AI 实机验证修复

### 修复

- **MiniLM tokenizer 加载失败（真浏览器实机验证发现）**：transformers.js v4.2 的文件
  元数据探测（`_get_file_metadata`）对**绝对 http URL** 形式的 `env.localModelPath`
  会跳过本地存在性检查（仅对非 http 路径走 `getFile`），且失败结果被
  `memoizePromise` 缓存在模块内存——tokenizer 文件被判定"不存在"，索引构建 7/7 全失败
  （`tokenizer_class undefined`）。修复：`localModelPath` 改用相对路径 `/models/`
  （`env.fetch` 按页面 origin 解析）。实机复测：索引 7/7 成功、二次构建增量跳过 7、
  WebGPU 本地对话端到端可用。
- **知识库拉全量**：`/events` 默认 limit=50，KB 显式带 `limit=1000`。

### 新增

- **知识库加入联系人**：KB 现在覆盖 事件 + 文档 + 联系人（姓名/昵称/关系/备注）。

### 验证记录（Playwright 真实浏览器，Chromium WebGPU）

- 运行环境探测：WebGPU + shader-f16 ✅、同源权重可达 ✅
- 索引构建：首次 7 新建 / 0 失败；二次 7 全部哈希跳过（增量契约成立）
- 提问「重阳节是什么时候」：语义检索命中重阳节等 6 条 → Qwen2.5-0.5B WebGPU 本地生成回答 + 来源徽章

## v2.24.0 (2026-10-05) — 本地 AI：浏览器端推理（模仿知屋方案）

### 新增

- **本地 AI（实验）页面** `/local-ai`：把知屋已验证的浏览器端本地推理方案移植过来——
  Qwen2.5-0.5B-Instruct（q4f16，WebLLM 0.2.85）跑在浏览器 **WebGPU**（实测 40+ tok/s），
  向量化用 all-MiniLM-L6-v2 q8（transformers.js 4.2.0，384 维）。**数据全程不出本机、
  零云端 API 调用**——个人日历数据比聊天记录更私密，这正是它相对云端 AI 的存在理由。
- **知识库 RAG**：知识库 = 你自己的事件 + 文档；「问问你的数据」按检索增强作答，
  答案只依据知识库并带来源徽章，防小模型幻觉。无 WebGPU 时自动降级为纯检索
  （关键词/向量匹配），永不白屏。
- **增量向量索引**：IndexedDB 逐条存 `{id, contentHash, vector}`，构建时哈希未变
  即跳过——第一次「让它跑一阵子」，之后同一浏览器秒级完成；知屋同款契约。
- **权重随站点同源直发**：`frontend/public/models/`（mlc-ai 278MB + MiniLM 23MB，
  逐字节复制自知屋仓库，sha256 与 HF lfs.oid 对齐），构建零下载、运行时零第三方 CDN，
  首次拉取后浏览器 IndexedDB 永久缓存、离线可用。`.gitattributes` 钉死二进制。
- 设计与差异说明：[docs/LOCAL_AI_PLAN.md](docs/LOCAL_AI_PLAN.md)。

### 变更

- **CSP 放开本地推理所需指令**：`script-src` 增加 `'wasm-unsafe-eval'`，新增
  `worker-src 'self' blob:`（onnxruntime-web proxy worker）——vercel.json 与
  security-headers.ts 两处同步。
- 设置 → AI 助手新增「浏览器本地推理（实验）」入口；系统导航组新增「本地 AI」。

## v2.23.1 (2026-10-05) — 批量重试与送达性头

### 新增

- **一键重试全部失败**：提醒日志页新增「重试全部失败」——后端 `POST /trigger-logs/retry-failed` 把近 7 天内真实结果不是"已送达"的提醒（含部分失败）逐条补发，单次上限 10 条防止同时打爆渠道；成功/仍失败条数在完成后汇总提示。单条重试逻辑抽取为共用函数，两个入口行为完全一致（含按渠道合并写回、清暂停）。
- **渠道配置脱敏导出**：渠道页「导出配置」下载 JSON 备份（`/api/config/accounts/export`），所有凭据经与前端展示同一套脱敏器（token 只剩尾 4 位），文件可安全留存于网盘/仓库。
- **统计按账户维度**：`GET /channels/stats` 额外返回每个通知账户的发送/成功/成功率；统计卡底部新增「按账户」徽章行——同渠道多账户时一眼看出哪个账户在拖后腿。
- **登录页记住用户名**：登录成功后记住用户名（仅用户名，绝不存密码），下次自动预填。
- **卡片上次测试时间**：渠道账户卡片显示"上次测试 N 分钟/小时/天前"与该账户的真实发送统计。

### 修复

- **邮件送达性头**：Resend 与 SMTP 路径补齐 `Reply-To`、`List-Unsubscribe`（mailto: 一键退订语法，RFC 8058）与 `X-Entity-Ref-ID` 去重引用头——缺退订头是个人发件域名被判营销/垃圾邮件的常见扣分项。
- **测试时间脆弱**：`dual-calendar-reminder.test.ts` 硬编码事件日期 2026-10-05，跨过真实日期边界后主题断言随机翻红（"明天"变"今天："），已用 fake timers 冻结到固定时刻。

### 优化

- `/channels/stats` 查询加 `ORDER BY created_at DESC LIMIT 5000`（统计是概览不是审计，避免超大日志量全表扫描），并只取需要的两列。
- 一键自检账户数硬上限 50，防异常数据把自检变成数百次出站请求。
- 自检完成后同步刷新发送统计卡（原先要手动刷新页面）。

## v2.23.0 (2026-10-04) — 通知必达批次：保持登录 / 渠道暂停恢复 / 46 渠道

### 新增

- **4 个新通知渠道（42 → 46）**：WhatsApp Cloud API（Meta 官方，区别于 Twilio）、Kook、Fanbook、Home Assistant（notify 服务 + 长期访问令牌）。全链注册：目录模板 → 账号解析 → 主分发 → 回退分发 → 连接测试 → 渠道矩阵文档。
- **渠道自动回退开关**：设置 → 高级通知 可整体关闭「指定渠道失败后自动改用其他渠道」的行为（默认开启）。v78 迁移新增 `user_configs.fallback_enabled`。
- **一键全渠道自检**：渠道页「全部测试」改为服务端批量自检 `POST /channels/test-all`（并发 4、结果逐账户落库、成功即清除 24h 暂停），完成后显示汇总并刷新各卡片连接状态。
- **近 30 天发送统计卡**：渠道页新增健康概览卡，`GET /channels/stats` 从触发日志的 `channel_results` 聚合每个渠道的发送/成功/失败与成功率（内部 `_fallback_*` 标记与坏行不计入）。
- **暂停渠道手动恢复**：连续失败被 24h 暂停的账户卡片上，「⏸ 暂停中」变为可点击徽章（`POST /channels/resume`，仅限本人账户）。
- **邮件模板实时预览（Dry-run）**：设置 → 高级通知 选模板风格时可展开预览：iframe 渲染邮件 HTML 效果 + 纯文本块预览 IM/推送渠道实际收到的内容，均不真实发送。

### 修复

- **保持登录真正生效**（对照同类应用的会话行为逐项排查）：
  - 启动校验超时 5s → 12s，且 cookie 校验失败时**先尝试 refresh 再判登出**，网络抖动不再被误判为掉线；
  - 记住登录的会话获得**滑动续期**：refresh 时把会话与 cookie 同步顺延 30 天（`renewRememberedSession`），长期使用不再固定 30 天后被登出；
  - 页面重新可见/聚焦时 12h 节流的静默续期；一个标签登出，其它标签经 storage 事件同步登出；
  - `api.getRaw` 收到 401 时自动 refresh 并重试一次。
- **通知"有时收不到"的三个根因**：
  - 连续 3 次失败从**硬禁用**（is_active=FALSE，从所有解析器里消失）改为 **24h 暂停**（`suspended_until`），任何一次成功/测试成功/手动重试立即恢复；暂停中的账户不参与路由与回退；
  - 提醒补发窗口上限 60 分钟 → **1440 分钟（24h）**，且支持按用户在设置里覆盖（`reminder_catchup_minutes`，留空用部署默认 10 分钟）——cron 停摆半天后当天漏掉的提醒也能补上；
  - 渠道级回退上限 2 → 6 次，回退结果不再污染主渠道的键（改用 `_fallback_*` 内部标记），日志可区分主发与回退。

### 变更

- **邮件送达性**：新增 card / minimal 两套现代模板（表格布局 + 内联样式 + 深色适配 + 隐藏 preheader + 单链接低垃圾分特征；classic 保持逐字节不变作回归护栏）；设置里可选风格；渠道页新增「邮件送达健康」卡（SPF/DKIM/DMARC 逐项清单 + onboarding@resend.dev 警告）。邮件进垃圾箱的根因在发件域名认证，模板与清单帮助把可控项做到位。

## v2.22.1 (2026-10-04) — MFA 恢复码与提醒日志收尾

### 新增

- **TOTP 恢复码（recovery code）**：启用 2FA 后可在「安全中心 → 双因素认证」用账号密码 + 当前验证码签发 10 个（最多 20 个）一次性恢复码。验证器丢失时，在登录页验证码框填恢复码（格式 `xxxxx-xxxxx`，大小写/连字符/空格均可）即可登录。存储只存 SHA-256 哈希，明文仅签发时显示一次；重新签发作废旧码，关闭 2FA 一并清空。登录经恢复码成功会记录安全事件 `totp_recovery_code_used`。迁移 v76 新增 `users.totp_recovery_codes`（JSONB）。
- **关闭 2FA 的界面入口**：后端 `/api/security/totp/disable` 一直存在，但前端没有入口。现在 TOTP 卡片在已启用状态下提供「关闭双因素认证」按钮（需密码 + 当前验证码，带二次确认）。
- **提醒日志按真实结果筛选**：状态下拉从裸 `status`（成功/失败）改为 `outcome`（成功/部分失败/失败/跳过）。「部分失败」落库时 `status='success'`，旧筛选下选"成功"会混入它、选"失败"看不到它。后端由 `services/trigger-log-delivery-filter.ts` 用与 `readDelivery` 同一份判定推导。

### 修复

- **手动重试不再覆盖 `channel_results`**：重试一个"部分失败"的行时，改为按渠道合并（本次结果覆盖同名渠道），原先已成功渠道的条目保留，不再从界面与审计轨迹里消失。
- **`email-compose.test.ts` 时间依赖**：模板按"距事件几天"选措辞，测试原先依赖真实当前时间，跨日期边界（如事件前一天运行）会随机变红。已用 fake timers 冻结时间基准。
- **v77 迁移：遗留 `email` 渠道归并为 `resend`**：投递代码一直把两者同路径处理，但 `email` 没有界面模板，导致账户/事件勾选里的 `email` 是"活跃却不可见"的渠道。存量数据归并后即可在界面查看与管理；代码里的 `email` 别名保留作兜底。历史触发日志（审计记录）不改写。

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
- **双因素认证恢复码：已完成（v2.22.1）**。签发（安全中心，需密码 + 当前验证码）、一次性消费（登录页验证码框可直接填恢复码）、哈希存储、重新签发作废旧码，见 v2.22.1 条目。
- **170 Wave 19 端到端验证：已执行**。`frontend/e2e` 全量 23 个 spec 在真实浏览器（`PLAYWRIGHT_CHANNEL=chrome`，本机已装 Chrome/Edge 时无需下载 Playwright 自带 Chromium）下跑完：**131 通过 / 1 失败**。这些用例自带有状态 API mock，只需要 Vite dev server，不需要真实后端或数据库。通知「延后」按钮覆盖了 access cookie 过期 → 换 refresh cookie → 重试一次且不重试成风暴的完整链路。
  跑这一轮时发现并修掉了两个真实缺陷（均非「测试环境问题」）：
  - **`install-prompt.js` 从未进过仓库**：`index.html` 一直引着它，于是**每次加载页面都 404**（dev 与生产都是）。它同时导致 `almanac` / `almanac-advanced` 两条「无 console error」断言必然失败，并且 PWA 安装横幅（checkbox 85）从未出现过。已补上实现（含中英文文案，跟随 i18n 的 `localStorage.lang`）。
  - **`basic.spec.ts` 不是自包含的**：它不打 API mock，而 dev 模式下 `lib/api.ts` 的 API_BASE 是绝对的 `http://localhost:3000/api`，于是「未登录」这件事由**占用 3000 端口的进程**决定（本机是另一个项目，实测两种结果都出现过）。已补上 401 mock。
  剩下唯一一条失败是既有的环境限制、非功能缺陷：`pwa-offline.spec.ts` 的「Chrome installability checks」—— Chrome 对 Vite dev server 报 installability error（已把 `sw.js`、`playwright.config.ts` 回退到 `ff17f04` 复跑确认与本次改动无关）。
  另外 `almanac-advanced` 与 `basic` 在并行执行时偶发失败、`--workers=1` 下稳定通过，属测试间干扰，未定位到根因，如实记录。

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
