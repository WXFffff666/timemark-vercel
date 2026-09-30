# 后台 AI（BACKGROUND_AI）

> 本文描述 TimeMark 的「后台 AI」层（计划 F5 / F6，checkbox 112-131）。
> 它是**可选层**：不配置任何 AI 供应商时，整个后台仍然可用，所有例程以**确定性规则**运行，零模型调用。
> 相关文档：模型接入见 [AI.md](AI.md)，工具 / MCP 安全边界见 [AGENT.md](AGENT.md)，
> 本地 Worker 协议见 [WORKER.md](WORKER.md)，定时任务与外部触发见 [CRON.md](CRON.md)，
> 对象存储与附件见 [ATTACHMENTS.md](ATTACHMENTS.md)。

---

## F5 / F6 架构

### F5：持久化后台作业运行时

F5 是「一个完整的、可以在后台运行的 AI」的运行时部分。它不是一个常驻进程，而是：

- **持久化队列**：`agent_jobs` 表（迁移 `agent_jobs_v54`）是任务的唯一事实来源，
  由 `backend/src/services/agent/queue.service.ts` 读写。
- **领取用行锁**：`SELECT ... FOR UPDATE SKIP LOCKED` 加租约（`lease_token` /
  `lease_expires_at`）、心跳、幂等键（`UNIQUE (user_id, idempotency_key)`）。
- **退避与死信**：失败按 30s 起、翻倍、上限 6h、再叠加不超过 20% 抖动退避；
  超过 `max_attempts`（默认 3）进入 `dead_letter`，错误码 `LEASE_EXPIRED` 表示租约过期回收。
- **有界执行**：由 `backend/src/routes/agent-worker.ts` 的
  `POST /api/agent/worker/drain` 领取一小批（默认 3，硬上限 50）并执行后立即返回，
  单次响应预算默认 25s（为 cron-job.org 的 30s 上限留余量），函数硬上限 300s。
- **调度链**：`backend/src/services/agent/scheduler.workflow.ts` 把「下一跳时间」全部放在
  Postgres 的 `scheduler_runs.next_run_at` 列里，`POST /api/agent/scheduler/start`
  每次只推进一个 tick。默认 tick 间隔 10 分钟。
- **作业种类**：`morning_brief`、`evening_review`、`weekly_review`、`hourly_triage`、
  `watchdog`（见 `queue.service.ts` 的 `AGENT_JOB_KINDS`）。

> 计划早期版本曾设想用 Vercel Workflow 的 `sleep()` 做常驻循环；**Revision 2 已废弃该方案**。
> 现行实现不引入 Vercel Workflow DevKit，改为「表驱动的调度链 + 外部触发」，
> 每次 tick 都是短时、有界的一次函数调用。`WORKFLOWS_ENABLED` 仅作为该调度链的总开关保留。

### F6：主动但安静的例程

F6 建立在 F5 之上，产出主动触达：

- **例程**：早间简报、晚间复盘、周度复盘、每小时巡检
  （`backend/src/services/agent/routines/`）。
- **确定性优先**：例程本身**零模型调用**；只有可选的 `ctx.narrator` 会调用一次模型，
  未配置模型、超预算或抛错时，直接使用模板正文。
- **人工确认**：任何要改数据的提案都先落成「批准 / 改 / 拒绝」决策卡（`decision_cards` /
  `agent_confirmations`），用户的可选「为什么」理由进入偏好记忆（`agent_feedback`）。
- **反噪音**：每日提醒预算、静默时段、去重窗口、例程冷却共同保证它不吵（见下文「预算模型」）。

### 与其它文档的关系

| 主题 | 文档 |
|---|---|
| 模型供应商、tier、`decide()` 与本地模型 | [AI.md](AI.md) |
| 工具注册表、scoped token、MCP、提示注入围栏 | [AGENT.md](AGENT.md) |
| 本地 Worker 协议、安装为服务、无需开端口 | [WORKER.md](WORKER.md) |
| Vercel 内置 cron 与 cron-job.org 清单、认证 | [CRON.md](CRON.md) |
| 附件只存对象存储、2 MB 上限、无病毒扫描的限制 | [ATTACHMENTS.md](ATTACHMENTS.md) |

---

## 免费额度与平台约束

后台 AI 被设计成**完全上云、零付费、无常驻计算**。约束来自三个平台：

### Vercel Hobby

- 内置 cron **最小间隔为每天一次**（子日级表达式在部署时直接报错），调度精度按小时（±59 分钟）。
- 函数最大执行时长 **300 秒**（`vercel.json` 已设为 300）。
- Hobby 额度是**账号共享**的；官方说明「超额会暂停 Hobby」，会连累同账号下其它项目的构建与部署。
  因此后台 AI **不引入常驻循环、不依赖 Vercel Queues（beta）、不依赖 Workflow 运行历史**（Hobby 只保留 1 天）。
- 详细清单与理由见 [CRON.md](CRON.md) 的「平台限制」一节。

### Neon Free

- 免费额度 **100 CU-hours / 项目 / 月**，且**空闲 5 分钟强制 scale-to-zero**（Free 档不能关闭）。
- 一个 0.25 CU 的计算常开 24/7 约 **182.5 CU-hours/月**，会超额并挂起数据库。
  因此**任何触碰 Postgres 的轮询间隔必须严格大于 5 分钟**。
- 调度链默认 **10 分钟一跳**：约 4,320 tick/月，按每次约 3s 估算约 **0.9 CU-hours/月**。
- `backend/src/services/agent/neon-budget.service.ts` 提供估算器，并在用量达到 **70% / 90%** 时各告警一次。

### cron-job.org

- 免费，单次执行 **30 秒上限**。
- 用它的自定义 Header 携带 `Authorization: Bearer $CRON_SECRET`；机器 `POST` 还需
  `X-Requested-With: XMLHttpRequest`（CSRF 防护要求）。
- 空闲时不消耗任何 Vercel 资源，这正是「无触发即零消耗」的关键。

### 为什么 Postgres 队列是唯一事实来源

所有持久状态都放在**本项目自己的 Postgres 表**里，而不是任何平台的运行历史中：

| 表 | 作用 |
|---|---|
| `agent_jobs` | 作业、状态、租约、尝试次数、幂等键、成本 |
| `agent_job_events` | 追加式运行记录与审计轨迹 |
| `scheduler_runs` | 调度链的 `next_run_at` 与心跳 |
| `agent_workers` | 外部 Worker 的 `last_seen_at` 注册 |
| `agent_routines` / `agent_routine_artifacts` | 例程定义与投递去重 |
| `agent_feedback` | 决策反馈形成的偏好记忆 |

这样做的理由：Vercel Hobby 的 Workflow 运行数据只保留 1 天，Vercel Queues 仍是 beta，
两者都不适合作为唯一状态源。Postgres 队列在没有任何平台加速器时也能完整工作，
交付语义是**至少一次（at-least-once）**，因此每个处理器都必须按
`(user_id, idempotency_key)` 幂等。

---

## 触发拓扑

```
cron-job.org（免费，外部）                        Vercel 内置 cron
        │                                                │
        │ 每 1 分钟  POST /api/agent/worker/drain         │ 每天 02:00
        │ 每 10 分钟 POST /api/agent/scheduler/start      │ /api/cron/daily-maintenance
        ▼                                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Vercel Function（有界、短时返回，无常驻）                         │
│   drain   : 领取一批 agent_jobs，执行，写结果                     │
│   start   : 推进一个调度 tick，把到期例程入队                     │
└────────────────────────────────────────────────────────────────┘
        │
        ▼
   Postgres（agent_jobs / scheduler_runs / ...）= 唯一事实来源
```

### 内置 cron（每天一次）

`vercel.json` 的 `crons` **只有一条**：`/api/cron/daily-maintenance`（`0 2 * * *`）。
它负责保留期清理、日统计聚合、通知重试等每日批次工作。子日级的
`reminder-check`、`retry-notifications` 等始终由外部触发，绝不出现在 `vercel.json` 里。

### 外部 cron-job.org

| 端点 | 频率 | 说明 |
|---|---|---|
| `POST /api/agent/worker/drain` | 每分钟 | 领取并执行后台作业（也可只领取，交给本地 Worker） |
| `POST /api/agent/scheduler/start` | 每 10 分钟 | 推进一个调度 tick，把到期例程入队 |
| `GET /api/agent/worker/drain` | 探测 | 存活探测，不查库、不领取 |
| `GET /api/agent/scheduler/start` | 探测 | 存活探测，不查库、不 tick |

后台 AI 的启用方式就是**在 cron-job.org 上配置这两个 POST 任务**；不配置就完全不运行，
不会占用任何 Vercel 或 Neon 资源。完整清单与一键脚本见 [CRON.md](CRON.md)。

### 鉴权

- `/api/agent/scheduler/start`：`Authorization: Bearer $CRON_SECRET`。
- `/api/agent/worker/drain`：`Authorization: Bearer $CRON_SECRET`，或可选的
  `AGENT_WORKER_TOKEN`（便于与 cron 独立轮换），两者都要带 `X-Requested-With: XMLHttpRequest`。
- 常量时间比较；未配置密钥时端点**关闭**（500），绝不放开。

---

## 预算模型

后台 AI 有三层预算，互相独立。

### 每月 AI 预算（成本护栏）

- 环境变量 `AGENT_MONTHLY_TOKEN_BUDGET` 与 `AGENT_MONTHLY_CALL_BUDGET`
  （见 `budget.service.ts` 的 `MONTHLY_BUDGET_ENV`）。留空表示不限制。
- 每次执行前用 `agent_jobs.cost_tokens` 里**真实记录的**消耗评估，而不是估算：
  - 预算耗尽：`lite` 作业跳过、`medium` 作业延后、`high` 作业仍执行但标记超额。
  - **AI 未配置时一律放行**，所以确定性路径永远不会被预算挡住。
- 具体实现在 `job-runner.service.ts`，它同时按 kind 解析 tier（`lite` / `medium` / `high`，
  见 [AI.md](AI.md) 的 tier 说明）。

### 每日提醒预算（反噪音）

- `AGENT_NOTIFICATION_BUDGET_PER_DAY`：每用户每天主动触达上限，**默认 3**；
  显式 `0` 表示不主动发送；非法值回退默认。
- `AGENT_NOTIFICATION_DEDUPE_WINDOW_MS`：同类通知去重窗口，默认 6 小时。
- `AGENT_ROUTINE_COOLDOWN_MS`：同一例程的冷却，默认 60 分钟，避免反复打扰。
- `critical` / `user_initiated` / `urgent` 类通知不受该预算限制；静默时段内主动触达被抑制并计数。
- 实现在 `notification-budget.service.ts`。

### Neon CU-hours 预算

- `NEON_FREE_CU_HOURS_PER_MONTH`（默认 100）、`NEON_COMPUTE_UNITS`（默认 0.25）。
- 在 **70% / 90%** 各告警一次，告警身份按窗口去重。
- 任何轮询间隔都被夹到 `MIN_POSTGRES_TOUCH_INTERVAL_MINUTES`（5 分钟）以上。

### 观测

- 每次执行在 `agent_job_events` 追加一条 `run_record`（例程、tier、模型、供应商、token、
  估算成本、耗时、结果、降级原因）。**绝不写入 prompt、补全、密钥或任何凭据。**
- 成本账本给出按天 / 当月的汇总与线性外推，月初边界与桶由数据库 `date_trunc` 计算。
- 自看门狗（`agent-watchdog.service.ts`）监视三类状况并各给出具体原因：
  `queue_stalled`（队列积压，默认 15 分钟）、`routine_failing`（连续失败，
  默认 3 次）、`provider_errors`（供应商错误，默认 1 小时窗口内 3 次）；
  同一状况每个窗口最多告警一次，恢复时最多发一次恢复通知。
- 控制面 API 与页面：`/api/admin/agent`（jobs / workers / runs / 成本 / 预算 / kill switch）。

---

## 本地 Worker（可选）

后台 AI **不需要**任何本地进程即可完全上云运行。如果你希望用本机算力接管队列，
可选运行一个**只出站**的本地 Worker：

- 协议：`POST /api/agent/worker/drain?mode=claim` 领取租约，Worker 本地执行后回传
  heartbeat / complete / fail，与服务器内执行**同一套协议**。
- 参考实现：`scripts/agent-worker.mjs`（仅用 Node 内置模块 + `fetch`），
  可安装为 NSSM / systemd / Task Scheduler 服务或 Docker 容器。
- 凭证：`AGENT_WORKER_TOKEN`（常量时间比较，不落库）；也可继续用 `CRON_SECRET`。
- **不开端口、不需公网、不需隧道**：Worker 只发起出站 HTTPS（到 TimeMark）与回环 HTTP（到 Ollama）。
- 完整契约、安装步骤与协议版本见 [WORKER.md](WORKER.md)。

Worker 是**可选加速**，不做也能完全上云。

---

## 默认关闭矩阵与已知限制

「默认关闭」要精确理解：**AI 供应商默认未配置，因此所有模型调用默认关闭并降级为确定性规则**；
调度与队列由外部触发驱动，不配置触发就没有任何运行。各变量在代码中的**实际默认值**如下。

| 变量 | 未设置时的行为 | 说明 |
|---|---|---|
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 空 | 云端 primary 供应商关闭 |
| `AI_FALLBACK_*` | 空 | 云端备用关闭 |
| `OLLAMA_BASE_URL` | 代码内默认 `http://localhost:11434/v1`，但槽位仍关闭 | 只有设置 `OLLAMA_MODEL` 才启用本地槽位 |
| `OLLAMA_MODEL` | 空 | 本地供应商关闭 |
| `EMBEDDINGS_ENABLED` | 非 `true` 即关闭 | 嵌入 / 语义检索默认关闭 |
| `MCP_ENABLED` | 非 `true` 即关闭 | MCP 传输层默认关闭 |
| `WORKFLOWS_ENABLED` | **默认开启**；设为 `false` / `0` / `off` 才关闭 | 调度链开关；无外部触发时仍不消耗资源 |
| `AGENT_TOOLS_ENABLED` | **默认开启**（仅当值恰好为 `false` 时整层禁用） | 动作 API / MCP 的 kill switch；`.env.example` 出厂值即 `false` |
| `AGENT_NOTIFICATION_BUDGET_PER_DAY` | `3` | 每日主动提醒预算 |
| `AI_DIGEST_NARRATIVE` / `AI_EVENT_TAGGING` / `AI_TEMPLATE_TRANSLATION` | `false` | 逐功能 AI 开关，默认关闭 |

已知限制（如实记录）：

- **本地模型无法被 Vercel 上的服务回连**：页面内助手需要云端免费供应商或一个公网可达的
  OpenAI 兼容端点；本地模型主要服务「本地 AI 主动连过来」的 MCP / 工具 API 方向。见 [AI.md](AI.md)。
- **cron-job.org 单次 30s 上限**：drain 的响应预算默认 25s，超时未完成的任务保持租约，
  由下一次 tick 回收，不会被记为失败。
- **至少一次语义**：处理器必须幂等，否则重复投递可能重复副作用。
- **Vercel Hobby 账号共享额度**：一旦被暂停会连累其它项目，因此本层刻意避免常驻计算。
- **Neon 5 分钟休眠地板**：子 5 分钟的数据库轮询会导致额度超额并挂起数据库。
- **无病毒扫描的附件**：见 [ATTACHMENTS.md](ATTACHMENTS.md) 的「已知限制」。
