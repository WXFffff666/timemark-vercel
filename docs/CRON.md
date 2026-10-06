# TimeMark 定时任务（Cron）拓扑

> **本文件是定时任务的唯一权威清单**（plan checkbox 87）。任何对 `backend/src/routes/cron.ts` 的增删改都必须同步更新下面的「调度总览」表。
>
> `pnpm lint` 会运行 `scripts/check-cron-docs.mjs`，它强制：
>
> - 总览表的路由集合与 `backend/src/routes/cron.ts` 的脚本提取结果**完全相等**（缺一条/多一条都会失败并指名路由）；
> - 每条路由都填写了「频率」列（缺失时失败并指名路由）；
> - 文档中禁止出现「子日级计划运行在 Vercel 内置 cron 上」的描述：
>   分钟级、小时级任务必须走外部调度器（Hobby 的部署限制，见下）。

## 平台限制（为什么不能全部交给 Vercel）

Vercel Hobby 内置 cron 的官方限制（[Cron usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)）：

| 限制项 | Hobby |
|:---|:---|
| 每项目 cron 数量 | 100 |
| 最小间隔 | **每天一次**（`0 * * * *`、`*/30 * * * *` 等子日级表达式会在**部署时报错**，不是被忽略） |
| 调度精度 | 按小时（±59 分钟，即 `0 1 * * *` 可能在 01:00–01:59 之间触发） |

函数最大执行时长（[Configuring max duration](https://vercel.com/docs/functions/configuring-functions/duration)）：Hobby 默认与上限均为 **300 秒**。
本仓库 `vercel.json` 的 `functions["api/index.js"].maxDuration` 已设为 **300**，为摘要、PDF 渲染、日历同步与 AI 调用留出余量。

结论：

- **只有「每天一次或更稀疏」的任务**可以放进 `vercel.json` 的 `crons`（当前仅 `daily-maintenance`）。
- 分钟级 / 按小时任务**必须**由外部 [cron-job.org](https://console.cron-job.org)（免费）触发。
- 双路并存是安全的：`/api/cron/*` 端点幂等，提醒发送另有 `reminder_send_claims` 去重；Vercel 内置 `daily-maintenance` 与外部任务可以同时启用。

## 认证

所有 `/api/cron/*` 端点统一要求同一个 Header：

```
Authorization: Bearer $CRON_SECRET
```

- **Vercel 内置 cron**：只要项目环境变量里配置了 `CRON_SECRET`，Vercel 会自动附带同样的 `Authorization` Header，无需额外配置。
- **cron-job.org**：在任务的 Custom Headers 中手动填写该 Header。
- **Agent worker drain（checkbox 114，`POST /api/agent/worker/drain`）**：除 `Authorization: Bearer $CRON_SECRET`（或可选的 `AGENT_WORKER_TOKEN`）外**还必须**带 `X-Requested-With: XMLHttpRequest`——应用的非 GET CSRF 防护要求「Bearer + 该标记」才放行没有 Origin/Referer 的机器请求，cron-job.org 的两条 Custom Header 都要填。
- 仅携带 `x-vercel-cron-auth-token` **不足以**通过鉴权（见 `backend/src/routes/cron.ts` 中间件；缺失 `CRON_SECRET` 时返回 500，Header 不匹配返回 401）。
- 可选：`CRON_ALLOWED_IPS`（逗号分隔）做来源 IP 白名单。

## 调度总览（全部路由）

路由列中的 `https://你的域名` 代指正式域名（例如 `https://timemark.example.com`）。

| 路由（`https://你的域名` + 路径） | 频率 | 调度方 | 说明 |
|:---|:---|:---|:---|
| `https://你的域名/api/cron/daily-maintenance` | `0 2 * * *`（每天 1 次；精度 ±59 分钟） | **Vercel 内置**（`vercel.json` 的 `crons`） | 会话清理、通知重试、保留期清理（触发日志/邮件/登录/队列）、Inbox/待办/习惯保留期、用药剂量物化与漏服、孤儿附件清理、日统计聚合、插件会话清理 |
| `https://你的域名/api/cron/reminder-check` | `* * * * *`（每分钟） | cron-job.org（外部，**必须**） | 到期提醒扫描 + 数据库预热（B28 起预热已并入本任务） |
| `https://你的域名/api/cron/retry-notifications` | `*/10 * * * *`（每 10 分钟） | cron-job.org（外部，**必须**） | 失败通知重试（5m/30m/2h/6h 指数退避） |
| `https://你的域名/api/cron/calendar-sync` | `*/15 * * * *`（每 15 分钟） | cron-job.org（外部，**必须**） | 外部 ICS 订阅 + Google OAuth 日历同步 |
| `https://你的域名/api/cron/caldav-sync` | `*/30 * * * *`（每 30 分钟） | cron-job.org（外部，推荐） | CalDAV 只读订阅同步 + 可选回写（每用户默认关闭） |
| `https://你的域名/api/cron/lunar-phase-reminders` | `* * * * *`（每分钟） | cron-job.org（外部，**必须**） | 农历初一/十五提醒（依赖提醒引擎的 ±2 分钟窗口） |
| `https://你的域名/api/cron/channel-health` | `0 3 * * *`（每天 1 次） | cron-job.org（外部，推荐；每日一次，Vercel 内置亦可） | 活跃渠道健康检查（只写状态，从不自动停用账号） |
| `https://你的域名/api/cron/digest?period=monthly` | `0 9 1 * *`（每月 1 日 09:00；年度摘要另建 `?period=yearly`；v2.30 起同端点还支持 `?period=daily`/`weekly`，逐用户按设置页排程到点判断） | cron-job.org（外部，推荐；每月一次，Vercel 内置亦可） | 月/年摘要（Inbox + 邮件 PDF 附件）+ AI 日报/周报（设置页开关默认关） |
| `https://你的域名/api/cron/warmup` | `* * * * *`（每分钟，可选） | cron-job.org（可选） | 冷启动预热；B28 起已并入 `reminder-check`，可停用 |
| `https://你的域名/api/cron/daily-email-backup` | 按需（未调度） | 未调度（legacy） | GitHub 备份旧入口；`daily-maintenance` 已包含 |
| `https://你的域名/api/cron/daily-login-backup` | 按需（未调度） | 未调度（legacy） | 登录历史归档旧入口；`daily-maintenance` 已包含 |
| `https://你的域名/api/cron/hourly-cleanup` | 按需（未调度） | 未调度（legacy） | 会话清理旧入口（名称保留，未配置调度） |
| `https://你的域名/api/cron/plugin-session-cleanup` | 按需（未调度） | 未调度（legacy） | 插件会话清理；`daily-maintenance` 已包含 |

> 无法运行在 Vercel 内置 cron 上的任务（子日级）：`reminder-check`、`retry-notifications`、`calendar-sync`、`caldav-sync`、`lunar-phase-reminders`、`warmup`。
> `channel-health`（每天一次）与 `digest`（每月一次）本身也满足「每天一次或更稀疏」，可以放进 Vercel 内置；本部署为保持**单一调度面板**（改频率无需重新部署）仍统一放在 cron-job.org。

## 外部 cron-job.org 清单（8 条必配 + 1 条可选）

在 [console.cron-job.org](https://console.cron-job.org) 逐条创建，Header 见上文「认证」（`POST` 端点需再加 `X-Requested-With: XMLHttpRequest`）。以下 8 条是本部署要求配置的完整清单，另附可选 `warmup`。

| # | 任务 | 完整 URL | 推荐 Schedule |
|:--:|:---|:---|:---|
| 1 | `reminder-check` | `https://你的域名/api/cron/reminder-check` | `* * * * *`（每分钟） |
| 2 | `retry-notifications` | `https://你的域名/api/cron/retry-notifications` | `*/10 * * * *`（每 10 分钟） |
| 3 | `calendar-sync` | `https://你的域名/api/cron/calendar-sync` | `*/15 * * * *`（每 15 分钟） |
| 4 | `caldav-sync` | `https://你的域名/api/cron/caldav-sync` | `*/30 * * * *`（每 30 分钟） |
| 5 | `lunar-phase-reminders` | `https://你的域名/api/cron/lunar-phase-reminders` | `* * * * *`（每分钟） |
| 6 | `channel-health` | `https://你的域名/api/cron/channel-health` | `0 3 * * *`（每天 1 次） |
| 7 | `digest`（月度） | `https://你的域名/api/cron/digest?period=monthly` | `0 9 1 * *`（每月 1 日 09:00） |
| 7b | `digest`（年度，可选） | `https://你的域名/api/cron/digest?period=yearly` | `0 9 1 1 *`（每年 1 月 1 日 09:00） |
| 7c | `digest`（日报+周报，v2.30，可两条分别建） | `https://你的域名/api/cron/digest?period=daily` 与 `?period=weekly` | 日报 `0 21 * * *`、周报 `0 9 * * 1`（设置页默认关，到点+查重双保险） |
| 8 | `agent-worker-drain`（**POST**） | `https://你的域名/api/agent/worker/drain` | `* * * * *`（每分钟；见下节，后台任务启用后必配） |
| 9 | `warmup`（可选） | `https://你的域名/api/cron/warmup` | `* * * * *`（每分钟；已并入 1，可停用） |

快速核对某条任务是否可用：

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://你的域名/api/cron/reminder-check
```

一键创建（需先在 cron-job.org → Settings 生成 API 密钥）：

```powershell
.\scripts\setup-external-cron.ps1 -CronJobOrgApiKey "你的cron-job.org-API密钥"
```

脚本会读取 Vercel 中的 `CRON_SECRET`，并在 cron-job.org 上创建 `reminder-check`（每分钟）与 `retry-notifications`（每 10 分钟）。

## Agent worker drain（checkbox 114）

后台 AI 任务队列（checkbox 112-113 的 `agent_jobs`）由 `backend/src/routes/agent-worker.ts` 的 worker 端点执行——它**不在** `routes/cron.ts` 里，因此不参与上面的「调度总览」护栏（`scripts/check-cron-docs.mjs` 只解析 cron.ts 的路由）。

| 项目 | 值 |
|:---|:---|
| 触发 | cron-job.org，`* * * * *`（每分钟；分钟级调度**不能**写进 Vercel 内置 cron，见上文平台限制） |
| 端点 | `POST https://你的域名/api/agent/worker/drain` |
| Headers | `Authorization: Bearer $CRON_SECRET`（或 `AGENT_WORKER_TOKEN`）**+** `X-Requested-With: XMLHttpRequest` |
| 响应 | 恰好 `{claimed, succeeded, failed, reclaimed, remaining}`（基础设施故障时同一响应体再带 `error`） |
| 存活探测 | `GET https://你的域名/api/agent/worker/drain`——无鉴权、不查库、不领取任务 |

有界机制（全部在路由循环内实现，不靠假设）：

1. 单次调用只调用一次 `claimBatch(N, leaseSeconds)`，N 默认 **3**（`AGENT_DRAIN_LIMIT` 或 `?limit=` / JSON `{"limit":n}` 可调，硬上限 50）。
2. 工作窗口 `cutAt = start + min(AGENT_DRAIN_DEADLINE_MS=45s, AGENT_DRAIN_RESPONSE_BUDGET_MS=25s)`：领取前检查剩余预算，逐任务执行前再检查；每个任务的执行与剩余预算赛跑（`Promise.race`）。
3. 预算耗尽立刻跳出循环并返回（慢处理器最多拖住 `responseBudget`，默认 25 s，为 cron-job.org 的 30 s 超时留余量）；未完成的任务保持 `leased`，不记为失败。
4. 下一次 tick 先执行 `reclaimExpiredLeases()`（租约到期后回到 `queued`），其回收数出现在 `reclaimed`；`remaining = 当前 queued 数 + 本次已领取但未完成数`。
5. 因此响应必在 300 s 函数上限与 30 s 外部超时之内，且响应体远小于 cron-job.org 的 64 KB 读取上限。

任务处理器尚未注册时（Wave 15 之前），默认执行器以 `NO_HANDLER` 失败任务而**不是**静默标记成功——不会把工作悄悄丢掉。后续 checkbox 注入真实执行器即可。

核验命令：

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "X-Requested-With: XMLHttpRequest" https://你的域名/api/agent/worker/drain
curl https://你的域名/api/agent/worker/drain   # 存活探测：{"status":"ok",...}
```

## 分享 / 嵌入页面的服务端 OG 元数据（checkbox 88 遗留项）

`vercel.json` 现在把 `/share/:token` 重写交给 API 函数（destination `/api/index`，在原路径上路由），由 `backend/src/routes/og.ts` 的 `GET /share/:token` **服务端渲染**事件级 OG/Twitter 标签与人类可读的兜底卡片。爬虫不再只拿到空壳 `index.html`。

| 路径 | 交付方 | 事件级 OG 元数据 |
|:---|:---|:---|
| `/share/:token` | 函数服务端文档（`og.ts`） | ✅ 事件名、倒计时、OG 图 |
| `/api/og/image/:token` | 函数（确定性 SVG） | ✅ |
| `/embed/:token` | SPA（`index.html`） | ❌ 有意保留 |
| 其他前端路由 | SPA（`index.html`） | —（通用标签） |

`/embed/:token` **没有**加重写，原因完整记录如下（不是半成品）：

1. `backend/src/routes/og.ts` 只定义了 `/share/:token` 的服务端文档，**没有** `/embed/:token` 分支；
2. 把 `/embed/:token` 指到现有分享文档会产生两个真实破坏：`og:url` 会错误地指向 `/share/<token>`（canonical 错误），且该服务端文档没有任何 SPA `<script>` 引导，嵌入组件（`CountdownWidget`）会直接失效；
3. 为 embed 增加服务端分支需要修改 `backend/**`，超出本任务的文件边界（禁止改 `backend/**`）。

后续若要补齐：在 `og.ts` 增加 `/embed/:token` 渲染分支，然后在 `vercel.json` 的 SPA 兜底之前加一条同形重写，并把 `scripts/check-cron-docs.mjs` 的 share 检查扩展到 embed。

路由顺序（`scripts/check-cron-docs.mjs` 断言）：`/api/(.*)` → `/share/:token` → SPA 兜底 `/((?!api/|.*\..*).*)`；同时断言 CSP、`X-Robots-Tag: noindex`、`/api/(.*)` 与 SPA 兜底重写都未被移除。

## 修改流程

1. 在 `backend/src/routes/cron.ts` 增删路由；
2. 同步更新本文「调度总览」表的对应行（频率列必填）；
3. 若任务需要子日级触发，在「外部 cron-job.org 清单」中补充对应行，并确认**没有**把子日级表达式写进 `vercel.json`；
4. 运行 `node scripts/check-cron-docs.mjs`（`pnpm lint` 已包含）——路由不齐或频率缺失会直接失败并指名。

## 参考（官方文档）

- [Cron usage & pricing（Hobby：100 条、每天一次、±59 分钟）](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Configuring maximum duration（Hobby 上限 300 秒）](https://vercel.com/docs/functions/configuring-functions/duration)
- [Rewrites（按顺序匹配，函数在原路径上路由）](https://vercel.com/docs/routing/rewrites)
- [cron-job.org 控制台](https://console.cron-job.org)
