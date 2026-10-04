# TimeMark Vercel

<div align="center">

<h1>🎂 TimeMark</h1>

<h3>智能事件提醒系统 | 46 个通知渠道 | 农历转换 | 关系映射</h3>

<p>一个为生日、纪念日等重要日期打造的全功能提醒系统。<br/>Vercel Serverless 部署，PostgreSQL 数据库，零服务器运维。</p>

---

[![Version](https://img.shields.io/badge/Version-2.22.0-blue?style=flat&color=2563eb)](https://github.com/WXFffff666/timemark-vercel)
[![GitHub Stars](https://img.shields.io/github/stars/WXFffff666/timemark-vercel?style=flat&color=f59e0b)](https://github.com/WXFffff666/timemark-vercel/stargazers)
[![Deploy with Vercel](https://img.shields.io/badge/Deploy%20with-Vercel-black?style=flat&logo=vercel)](https://vercel.com/new)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat&color=22c55e)](LICENSE)

---

[📖 免费部署指南](FREE_TIER_DEPLOY.md) · 
[📖 Vercel 完整文档](VERCEL_DEPLOYMENT.md) · 
[📧 通知系统指南](docs/NOTIFICATIONS.md) · 
[🔗 集成功能](docs/INTEGRATIONS.md) · 
[📋 可选功能说明](docs/OPTIONAL_FEATURES.md) · 
[🛡️ 安全评估](docs/SECURITY_AUDIT.md) · 
[⏰ Cron 拓扑](docs/CRON.md) · 
[🤖 AI 助手](docs/AI.md) · 
[🧠 后台 AI](docs/BACKGROUND_AI.md) · 
[🔐 Agent / MCP](docs/AGENT.md) · 
[🖥️ 本地 Worker](docs/WORKER.md) · 
[📎 附件存储](docs/ATTACHMENTS.md) · 
[🐛 问题反馈](https://github.com/WXFffff666/timemark-vercel/issues) · 
[⭐ Star 支持](https://github.com/WXFffff666/timemark-vercel/stargazers)

</div>

---

## 🚀 Vercel 版本

TimeMark Vercel 版是原 [timemark-docker](https://github.com/WXFffff666/timemark-docker) 的云原生重构版本，将架构从 Docker 容器迁移到 Vercel Serverless 平台。

| 对比项 | Docker 版 | **Vercel 版** |
|:------:|:---------:|:-------------:|
| 部署平台 | Docker / NAS | **Vercel Serverless** |
| 数据库 | SQLite (sql.js) | **PostgreSQL (Vercel Postgres / Neon)** |
| 定时任务 | Croner (Node.js) | **Vercel Cron + cron-job.org（免费）** |
| 运维成本 | 需管理服务器 | **零运维，按需付费** |
| 密钥管理 | data/.env 文件 | **Vercel Environment Variables** |
| 静态资源 | Docker 镜像内 | **Vercel Edge Network (CDN)** |
| 免费额度 | 需自备服务器 | **Vercel Hobby 免费套餐可用** |
| 通知渠道 | 38 个渠道 | **46 个 HTTP 渠道（Webhook/Token，云端可用）** |

### 架构优势

- **云原生**：Vercel Serverless Functions + PostgreSQL + Cron Jobs，无需管理服务器
- **全球加速**：前端通过 Vercel Edge Network CDN 分发
- **按需计费**：Vercel Hobby 套餐免费额度足够个人使用
- **自动扩缩**：Serverless 架构自动处理流量高峰
- **持续部署**：连接 GitHub 仓库，推送代码自动部署
- **PostgreSQL**：Vercel Postgres（Neon）提供 0.5GB 免费存储

### 🐳 姊妹项目推荐：Docker 单容器版

想要数据完全自持、跑在自己的 NAS 或内网里？同一个 TimeMark 也有自托管版 **[timemark-docker](https://github.com/WXFffff666/timemark-docker)** —— Docker 单容器部署、SQLite 内置存储、零外部依赖、闲置内存约 256MB，`docker compose up -d` 一条命令即可启动，**38 个渠道全部可用**（含微信个人号、QQ Bot、Signal 等云端不可用的插件类渠道）。

| 对比项 | 🐳 [Docker 版](https://github.com/WXFffff666/timemark-docker) | ☁️ Vercel 版（本仓库） |
|:------:|:----------------------------------------------------------:|:---------------------:|
| 部署平台 | Docker / NAS（群晖 · 威联通 · 铁威马 · 飞牛OS） | Vercel Serverless |
| 数据库 | SQLite (sql.js，内置) | PostgreSQL (Vercel Postgres / Neon) |
| 定时任务 | Croner（进程内每分钟检查） | Vercel Cron + cron-job.org |
| 通知渠道 | **38 个全部可用** | 46 个云端可用 HTTP 渠道 |
| 运维成本 | 需自备服务器 | 零运维，Hobby 免费套餐可用 |
| 适合场景 | 数据完全自持 / 内网 / NAS | 公网访问 / 免服务器 / 快速上线 |

> 两版共享同一套功能内核（通知模板、农历双历、待办、Inbox、Integrations、零信任安全加固等），按运行环境自由选择。

---

## ✨ 特性一览

| 🗓️ 精准农历 | 📢 多渠道通知 | 👨‍👩‍👧‍👦 智能关系映射 | 🔒 安全防护 | 🌍 全球时区 |
|:----------:|:----------:|:---------------:|:----------:|:--------:|
| 闰月自动转换 | 46 个通知渠道 | 36 种称呼映射 | 登录锁定 + 告警 | NTP 按用户时区校准 |
| 公历/农历/双历 | 同渠道多账户 | 家庭关系映射 | Turnstile + Passkey | 默认北京时间 |

| 📝 通知模板 | 🔄 重复事件 | 📧 多邮箱支持 | 📅 日历导出 | 🎯 11 种事件类型 |
|:----------:|:----------:|:------------:|:----------:|:---------------:|
| 57 种预设模板 | 每天/每周/每月/每年 | 多收件人邮箱 | ICS 文件导出 | 生日/纪念日/节日等 |
| 按事件类型分组 | 自动创建下次事件 | 联系人多邮箱/手机 | 年/月/日视图 | 会议/旅行/婚礼等 |
| 批量邮件 6 类模板 | 近期待办打勾完成 | 快捷发信可选收件人 | 待办完成历史 | 固定联系人分组 |

---

## 🧩 v2.17–v2.22 新增能力

> 下列能力逐项对应已落地的 checkbox。**默认关闭**或**尚未接线**的项均明确标注，不把未发布的能力当作已发布。

### 生活领域（v2.19.0，Waves 6-9）

| 能力 | 说明 |
|------|------|
| 📅 到期与续费中心 | 订阅 / 账单 / 保险 / 域名 / 保修，多级提前提醒，费用聚合进入统计 |
| 📦 库存与保养 | 数量 / 保质期 / 低库存阈值；按日期或用量的保养计划 |
| 🗂️ 文档保险箱 | 护照 / 证件 / 驾照 / 签证 / 证书 / 保单，对象存储附件（文件不入库，见 [docs/ATTACHMENTS.md](docs/ATTACHMENTS.md)） |
| 👥 个人 CRM | 互动日志与联系节奏，逾期联系人提醒 |
| 🔥 习惯打卡 | 连续天数与周视图 |
| 🏠 家庭多档案 | profiles 模型，列表与提醒按档案感知 |
| 💊 家庭用药 | 剂量排程、打卡、库存递减、依从性与可打印报告 |

### 机器人 / AI / Agent（v2.20.0，Waves 10-13）

| 能力 | 说明 | 文档 |
|------|------|------|
| 📆 中国日历增强 | 节假日 / 调休、农历 / 干支 / 生肖 / 宜忌 / 节气、节日感知提醒 | |
| 📊 周期摘要 | 月 / 年度图文摘要与「立即发送」 | |
| 🎯 目标与里程碑 | 进度跟踪与「N 年前的今天」 | |
| 🔔 Web Push / PWA | 浏览器推送回归为一等渠道，可安装、离线安全 | |
| 🔗 日历双向 / 分享 | CalDAV 只读与可选回写、公开 ICS 订阅、分享 / 嵌入 OG 元数据 | |
| 🤖 Telegram 机器人 | Webhook 密钥校验、去重、命令集、内联键盘、链接与审计 | |
| 🧠 AI 助手 | OpenAI 兼容网关（云端 / 本地）、NL 建事件、可选摘要 / 打标 / 翻译 | [docs/AI.md](docs/AI.md) |
| 🔐 Agent / MCP | scoped 可撤销令牌、两阶段确认、无状态 MCP 与只读资源 | [docs/AGENT.md](docs/AGENT.md) |
| 🔍 搜索 / 模式挖掘 | `pg_trgm` 中文搜索（零出网）与确定性模式挖掘；语义检索为可选 | |

### 后台 AI（v2.21.0，Waves 14-15）

| 能力 | 说明 |
|------|------|
| ⚙️ 持久化作业运行时 | Postgres 队列 + 有界 drain + 表驱动调度链，无常驻进程、无触发即零消耗 |
| 💰 预算护栏 | 模型分档、每月成本护栏、每日提醒预算（默认 3 条）、静默时段与去重 |
| 🌅 主动例程 | 早间简报 / 晚间复盘 / 周度复盘 / 每小时巡检（确定性优先） |
| ✅ 人工确认 | 批准 / 改 / 拒绝决策卡与「为什么」偏好记忆 |
| 🖥️ 本地 Worker | 可选的只出站 Worker，协议与服务器一致 |

详见 [docs/BACKGROUND_AI.md](docs/BACKGROUND_AI.md)、[docs/WORKER.md](docs/WORKER.md)、[docs/CRON.md](docs/CRON.md)。

### 扩展功能（v2.22.0，Waves 16-18）

| 能力 | 说明 |
|------|------|
| 🔎 全局搜索 / Ask | 跨实体搜索与零 AI 的问答面板 |
| 🏷️ 标签 / 去重 / 批量 | 跨实体标签与 AND/OR、去重助手（含撤销）、批量操作（逐项结果） |
| 📋 今日一览 / 数据健康 | 可配置卡片；结构自检与安全一键修复、渠道修复向导 |
| 🧰 模板 / 默认 / 审计 | 例程模板、历史智能默认、撤销与审计轨迹 |
| 📥 外部订阅 | ICS / 只读 IMAP 入库（带来源标签，不回写） |
| 🎙️ 本地语音 / OCR | 浏览器本地语音建事件（不上传）；OCR 默认关闭 |
| 🖨️ 打印 / 导出 | 本地渲染 HTML 再打印为 PDF，零出网 |
| 🔗 分享 / 备份 | 家庭只读分享；加密 WebDAV / S3 兼容备份 |
| 🌤️ 黄历 / 天气 / 包裹 | 进阶黄历（附免责声明）、Open-Meteo 天气与空气质量、包裹跟踪 |
| 🚗 工时 / 照护 / 车辆 / 清单 | 考勤工时、儿童 / 长者 / 宠物照护、车辆油耗与保养、观影 / 阅读清单 |

> ⚠️ **后端已挂载，前端缺页面**：照护 / 宠物 / 车辆 / 观影清单 / 双向日历同步 / 家庭协作的 API
> **已经挂载**在 `backend/src/index.ts`（`/api/care`、`/api/pets`、`/api/vehicles`、
> `/api/watchlist`、`/api/calendar-sync`、`/api/collaboration`），可直接调用；真正缺的是
> **前端页面与导航入口**，界面上暂时无法使用。（考勤工时与家庭库存则确实尚未挂载。）
> 字段级加密（161）与联系人生日祝福（168）**已实现**
> （`backend/src/services/field-encryption.service.ts`、`birthday-greeting.service.ts`）。
> Wave 19 端到端验证（170）**已执行**：`frontend/e2e` 全量 23 个 spec 在真实浏览器下跑完，
> 131 通过 / 1 失败（仅剩 PWA 可安装性检查，dev server 的环境限制）。本轮还修掉了
> 「`install-prompt.js` 从未进仓库导致每次加载都 404」与「basic 用例不自包含」两个真实缺陷，
> 详见 [CHANGELOG.md](CHANGELOG.md) 的 v2.22.0 条目。

---

## ⚡ 快速部署 (Vercel)

> 只需 5 步，5 分钟完成部署。需要 Vercel 账号和 GitHub 仓库。

### 前置准备

1. **Vercel 账号** → 注册 [vercel.com](https://vercel.com)（推荐用 GitHub 登录）
2. **Vercel Postgres** → 在 Vercel Dashboard 创建 Postgres 数据库
3. **GitHub 仓库** → Fork 或 Push 本仓库到你的 GitHub

### 一键部署到 Vercel

```bash
# 1. 安装 Vercel CLI
npm i -g vercel

# 2. 克隆仓库
git clone https://github.com/WXFffff666/timemark-vercel.git
cd timemark-vercel

# 2.1 安装依赖
pnpm install

# 3. 链接 Vercel 项目
vercel link

# 4. 设置环境变量
vercel env add DATABASE_URL
vercel env add JWT_SECRET
vercel env add MASTER_KEY
vercel env add CRON_SECRET

# 5. 部署
vercel --prod
```

### 初始化数据库

部署后数据库表会在 **首次 API 冷启动时自动迁移**（v1–v78）。也可手动执行：

```bash
# 拉取 Vercel 环境变量
vercel env pull .env

# 运行迁移（可选，与自动迁移等效）
npx tsx scripts/migrate-db.ts
```

部署完成后可在 **设置 → 部署向导** 查看「系统自检」（数据库连接、结构版本 v78、CRON_SECRET、Turnstile 等）。

部署完成！生产环境请绑定自定义域名（例如 `https://timemark.example.com`）。

### 生产域名与预览保护

对外仅暴露你的**正式自定义域名**。`*.vercel.app` 预览地址可保留给本人调试，但应开启 Vercel **Standard Protection**（部署保护）：

```powershell
# 开启后：正式域名公开；vercel.app 需 Vercel 账号登录
.\scripts\enable-vercel-protection.ps1

# 每次部署后清理多余 vercel.app 别名（Vercel 可能自动重建友好别名）
.\scripts\prune-vercel-aliases.ps1
```

当前生产别名应仅保留正式域名（如 `timemark.the37777777.top`）。部署保护已开启时，即使知道 `*.vercel.app` 地址也需 Vercel 账号才能访问。

环境变量建议：`CORS_ORIGIN=https://你的正式域名`，`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` 与正式域名一致。

**登录防爆破（推荐）**：在 Cloudflare 创建 Turnstile 后配置 `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`，步骤见 [docs/TURNSTILE_SETUP.md](docs/TURNSTILE_SETUP.md)。

| 项目 | 值 |
|:----:|:--:|
| 默认用户名 | `admin`（可由 `DEFAULT_ADMIN_USERNAME` 覆盖） |
| 默认密码 | **无默认值。** 部署前必须自行设置 `DEFAULT_ADMIN_PASSWORD`（≥12 位、非常见默认值） |

> ⚠️ **仓库不提供任何默认口令。** 生产冷启动时若 `DEFAULT_ADMIN_PASSWORD` 未设置或过弱，**不会创建管理员**，并记录 `ADMIN_BOOTSTRAP_REFUSED`（可在部署日志中检索）。请在 Vercel Production 环境变量中配置强密码后再部署。
>
> **首次登录后请立即修改密码！** 进入设置页面即可修改；安全中心会显示「初始密码是否已改过」（依据 `user_configs.password_changed_at`）。

### 详细部署文档

完整的部署指南 → [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)

### 本地开发与装包

依赖树已清理为标准形态（插件类渠道与其 exotic 依赖已移除），直接使用 pnpm 即可：

```bash
pnpm install
pnpm add <pkg>
```

Vercel 远程构建同样使用 `vercel.json` 中的 `installCommand: "pnpm install"`。

---

## 🏗️ 系统架构

```
┌──────────────────────────────────────────────────────────┐
│                 TimeMark Vercel                           │
│         Serverless · PostgreSQL · Cron Jobs               │
├──────────────────────────────────────────────────────────┤
│                                                          │
│   ┌──────────────┐         ┌─────────────────────────┐  │
│   │  Vercel CDN  │         │    Vercel Postgres       │  │
│   │  Static      │         │    (Neon PostgreSQL)     │  │
│   │  Frontend    │         │    Serverless SQL        │  │
│   │  (React SPA) │         │    60+ 张表 · 索引       │  │
│   └──────┬───────┘         └───────────┬─────────────┘  │
│          │                             │                │
│          │    ┌──────────────────┐     │                │
│          └───>│  Hono API        │<────┘                │
│               │  Vercel Function │                      │
│               │  /api/*          │                      │
│               └────────┬─────────┘                      │
│                        │                                │
│          ┌─────────────┼──────────────┐                 │
│          │             │              │                 │
│    ┌─────┴─────┐ ┌────┴─────┐  ┌────┴──────┐          │
│    │  Vercel   │ │  Auth    │  │  Alert    │          │
│    │  Cron     │ │  JWT     │  │  Service  │          │
│    │  Jobs x5  │ │  CSRF    │  │  通知分发  │          │
│    └───────────┘ └─────────┘  └───────────┘           │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 | 说明 |
|:----:|------|------|
| 前端 | React 19 + TypeScript + TailwindCSS 4 + Radix UI | 现代化响应式界面 |
| 后端 | Hono + TypeScript + lunar-javascript | Vercel Serverless Functions |
| 数据库 | PostgreSQL (Vercel Postgres / Neon) | Serverless SQL，0.5GB 免费存储 |
| 定时任务 | Vercel Cron（每日维护）+ cron-job.org（分钟级提醒） | 见 [FREE_TIER_DEPLOY.md](FREE_TIER_DEPLOY.md) |
| 认证 | JWT (HS256) | 会话认证 + 登录锁定 |
| 加密 | AES-256 + bcrypt | 凭证加密 + 密码哈希 |
| 部署 | Vercel | 自动部署，全球 CDN，零运维 |

---

## 📋 核心功能

### 固定联系人与批量邮件

| 功能 | 说明 |
|------|------|
| **多联系方式** | 每个联系人可配置多个邮箱、手机、Telegram / QQ / WxPusher，带标签区分（如「工作」「妈妈」） |
| **渠道绑定** | 勾选已配置的通知渠道账号；邮件类渠道使用联系人邮箱作为收件地址 |
| **快捷发信** | 仅 1 个邮箱时直接进入编辑；多个邮箱时先进入二级界面手动勾选收件人 |
| **批量邮件** | 从联系人选择收件人时自动展开其全部邮箱；支持模板变量 `{{contact_name}}` |
| **事件联动** | 创建事件时可从联系人一键填入提醒人，并合并其全部邮箱到 `emailRecipients` |

数据存储：`fixed_contacts.contact_methods`（JSONB，迁移 v30）；旧单字段 `email`/`phone` 等自动迁入并保留兼容。

### 近期待办

| 功能 | 说明 |
|------|------|
| **待办窗口** | 事件进入「提前 N 天」提醒窗口后出现在 `/todos` 与首页待办数字 |
| **打勾完成** | 点击圆圈标记完成，状态同步服务端（`todo_completions` 表，迁移 v29） |
| **自动移出** | 事件日期过期或离开提醒窗口后，从「待办 / 已完成」列表自动隐藏 |
| **完成历史** | 「完成历史」标签页查看已归档记录；数据库保留约 365 天后由 `daily-maintenance` 清理 |

---

### 事件管理

| 类型 | 说明 | 示例 |
|:----:|------|------|
| 🎂 生日 | 家人、朋友、同事的生日 | 妈妈的生日 (农历八月十五) |
| 💍 纪念日 | 结婚/恋爱/创业纪念日 | 结婚五周年 |
| 🎊 节日 | 传统节日和特殊日期 | 春节、中秋节、情人节 |
| 📝 考试 | 考试、面试等重要日期 | 英语六级考试 |
| 💼 会议 | 工作会议、商务会议 | 季度总结会 |
| ⏰ 截止日期 | 项目截止、任务到期 | 项目交付日期 |
| ✈️ 旅行 | 出行计划、航班提醒 | 日本旅行 |
| 🎓 毕业 | 毕业典礼、学位授予 | 大学毕业典礼 |
| 💒 婚礼 | 婚礼、订婚仪式 | 结婚纪念日 |
| 🏥 医疗 | 体检、复诊、用药提醒 | 年度体检 |
| 📌 自定义 | 任意重要日期 | 驾照到期、保险续费 |

### 日历支持

| 模式 | 说明 |
|:----:|------|
| **公历** | 标准公历日期 |
| **农历** | 农历文本输入，自动转换为公历存储；含闰月处理 |
| **双历** | 公历与农历双向同步；保存时写入 `lunarDate` 供 Cron 农历提醒 |

创建双历事件时，修改公历会自动推算农历，修改农历也会反算公历。系统对公历→农历→公历做往返自检（见 `/api/time/status` 的 `calendarVerify`）。

### 时区与 NTP

| 功能 | 说明 |
|------|------|
| **默认时区** | `Asia/Shanghai`（东八区 / 北京时间） |
| **全局联动** | 首页快捷时区与设置页同步；改时区后倒计时、待办、今日事件均按新时区计算 |
| **NTP 校准** | 后台从 WorldTimeAPI / timeapi.io 获取权威时间，校正服务器时钟漂移 |
| **跟随时区** | 用户切换时区后，NTP 与「今天」按该 IANA 时区校准 |
| **公开接口** | `GET /api/time/status?timezone=Asia/Shanghai`（可选 `&refresh=1` 强制同步） |

Cron 每分钟提醒任务使用校正后的时间，在配置的提醒时刻 ±2 分钟内触发。

### 提醒配置

| 配置项 | 可选值 |
|--------|--------|
| 提醒时间 | 06:00 - 22:00 + 自定义任意时间 (可多选) |
| 提前天数 | 1天 / 3天 / 7天 / 14天 / 30天 (可多选) |
| 通知渠道 | 46 个 HTTP 渠道任意组合 (可多选) |
| 重复事件 | 每天 / 每周 / 每月 / 每年 |
| 通知模板 | 57 种预设模板（覆盖 40 种事件类型）+ 自定义模板 |
| 收件人邮箱 | 支持多个收件人邮箱 |

### 通知模板

创建事件时，点击"预览通知"按钮，系统会根据事件类型自动显示对应的模板列表：

| 事件类型 | 可用模板 |
|:--------:|----------|
| 生日 | 生日提醒、生日简洁版、生日详细版、通用提醒、详细提醒 |
| 考试 | 考试提醒、考试紧急提醒、通用提醒、详细提醒 |
| 纪念日 | 纪念日提醒、纪念日简洁版、通用提醒、详细提醒 |
| 节日 | 节日提醒、节日家庭版、通用提醒、详细提醒 |
| 其他 | 通用提醒、详细提醒 |

支持自定义模板，可在设置页面创建和管理。

### 关系映射

智能转换称呼，让通知内容更自然：

| 原始称呼 | 智能转换 | 场景 |
|:--------:|:--------:|------|
| 我爸 | 父亲 | 发送给其他家庭成员时 |
| 我妈 | 母亲 | 发送给其他家庭成员时 |
| 老公 | 丈夫 | 统一正式称呼 |
| 爷爷 | 外公 | 家庭关系自动映射 |

---

## 📢 通知渠道（云端可用 46 个）

TimeMark Vercel 版仅保留 **Webhook / Token 类 HTTP 渠道**（无扫码插件、无长连接 IM）。所有渠道通过「通知账户」统一管理，支持同渠道多账户，创建事件时可选择发送目标。

> 📋 **权威清单**（自动生成；含每个渠道的必填字段 → 数据库列映射与连接测试路径）：[docs/CHANNEL_MATRIX.md](docs/CHANNEL_MATRIX.md)。  
> **云端不可用（已从前端与 API 移除）**：微信个人号、WhatsApp、QQ Bot、Signal、iMessage、Zalo、Clawbot、Nostr、浏览器 Web Push。  
> 完整兼容性说明见 [docs/CHANNEL_COMPATIBILITY.md](docs/CHANNEL_COMPATIBILITY.md)。  
> 通知配置与测试流程见 [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)。

### 🔗 集成（Webhook / 日历）

| 功能 | 说明 |
|------|------|
| 入站 Webhook | 外部系统 POST JSON 自动创建事件 |
| ICS 订阅 Feed | Google/Outlook 订阅本应用事件 |
| 外部 ICS 同步 | 从 Google 等日历 URL 拉取事件 |
| Google OAuth 同步 | **可选** — 主日历只读自动导入，见 [GOOGLE_CALENDAR_OAUTH.md](docs/GOOGLE_CALENDAR_OAUTH.md) |
| 冲突提示 | 通知中提示同日其他日程 |

详见 [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)。

### 🔗 Webhook 类（13 个）

| 渠道 | 说明 |
|------|------|
| 🟣 Discord | Discord 频道消息推送 |
| 💜 Slack | Slack 频道消息推送 |
| 🔵 飞书 (Feishu) | 飞书群聊机器人 |
| 🟢 企业微信 (WeCom) | 企业微信群聊机器人 |
| 🔷 钉钉 (DingTalk) | 钉钉群聊机器人（支持加签） |
| Google Chat | Google Chat 空间消息推送 |
| IRC | IRC 桥接 Webhook（如 matterbridge） |
| Synology Chat | 群晖 Chat 消息推送 |
| Twitch | Twitch EventSub Webhook |
| 通用 Webhook | 自定义 HTTP 回调（可选签名校验） |
| Rocket.Chat | Rocket.Chat 频道传入 Webhook |
| Kook | Kook（开黑啦）频道机器人 Webhook |
| Fanbook | Fanbook 频道机器人 Webhook |

### 🔑 Token 类（33 个）

| 渠道 | 说明 |
|------|------|
| 📧 Resend | Resend 邮件 API 推送（支持 HTML 模板） |
| 📧 SMTP 邮件 | QQ / 163 / Gmail / Outlook / 企业邮 SMTP 发信 |
| ✈️ Telegram | Telegram Bot 推送 |
| LINE | LINE Messaging API 推送 |
| Matrix | Matrix 消息推送 |
| Mattermost | Mattermost 频道推送 |
| Microsoft Teams | Teams 频道推送 |
| Nextcloud Talk | Nextcloud 聊天推送 |
| 📱 WxPusher | 微信公众号推送 |
| 💬 Qmsg | QQ 消息推送 |
| 📡 Server酱 (ServerChan) | 微信推送服务（Turbo） |
| PushPlus | 多渠道推送服务 |
| Bark | iOS 自定义推送通知 |
| Gotify | 自托管推送服务 |
| 喵推送 (Meow) | 喵推送消息 |
| PushMe | 多平台统一推送 |
| PushDeer | iOS / Android 跨平台推送 |
| Twilio SMS | 通过 Twilio 发送短信提醒 |
| 企业微信应用 (WeComApp) | 企微应用消息推送 |
| ntfy | 自托管 / 公共 ntfy 推送 |
| Pushover | Pushover 跨平台移动推送 |
| Apprise | 统一通知网关（80+ 服务） |
| 📡 Server酱³ (SC3) | Server酱³ 消息推送（sctp 开头的 SendKey） |
| 息知 (XiZhi) | 息知微信推送 |
| AnPush | AnPush 多渠道推送 |
| Chanify | Chanify iOS 推送（可自建服务端） |
| Pushback | Pushback 可回复通知 |
| SimplePush | SimplePush 简单推送 |
| Zulip | Zulip 流消息推送 |
| 🔥 Firebase 推送 (FCM) | Firebase Cloud Messaging HTTP v1 |
| 🟢 Twilio WhatsApp | 通过 Twilio 发送 WhatsApp 消息 |
| 🟢 WhatsApp Cloud | Meta 官方 WhatsApp Cloud API（区别于 Twilio） |
| 🏠 Home Assistant | HA notify 服务推送（长寿命令牌） |

---

## 🔐 首次登录

| 项目 | 说明 |
|:----:|------|
| 生产地址 | `https://timemark.the37777777.top` |
| 用户名 | `admin`（默认，可由 `DEFAULT_ADMIN_USERNAME` 覆盖） |
| 密码 | 必填 | 由 `DEFAULT_ADMIN_PASSWORD` 环境变量设定；**无默认值**，生产环境未设置或弱于 12 位时拒绝创建管理员 |

> ⚠️ **首次登录会强制修改密码**（`mustChangePassword`）。请在 Vercel Production 环境变量中设置强密码，勿将 `JWT_SECRET` / `MASTER_KEY` / `TURNSTILE_SECRET_KEY` / `CRON_SECRET` 勾选 Preview。

---

## ⚙️ 环境变量（Vercel Production）

| 变量 | 必填 | 说明 |
|------|:----:|------|
| `DATABASE_URL` | ✅ | Vercel Postgres 连接串 |
| `JWT_SECRET` | ✅ | ≥32 字符随机串，**仅 Production** |
| `MASTER_KEY` | ✅ | 通知凭证 AES 加密密钥，**仅 Production** |
| `CRON_SECRET` | ✅ | Cron 端点 Bearer 密钥，**仅 Production** |
| `CORS_ORIGIN` | 推荐 | 正式域名，如 `https://timemark.the37777777.top` |
| `TURNSTILE_SITE_KEY` | 推荐 | Cloudflare Turnstile 站点密钥（可公开） |
| `TURNSTILE_SECRET_KEY` | 推荐 | Turnstile 服务端密钥，**仅 Production** |
| `DEFAULT_ADMIN_USERNAME` | 可选 | 初始管理员用户名，默认 `admin` |
| `DEFAULT_ADMIN_PASSWORD` | **生产必填** | 初始管理员密码；无默认值，≥12 位且非常见默认值，否则冷启动拒绝创建并记录 `ADMIN_BOOTSTRAP_REFUSED` |
| `HEALTH_DETAIL_TOKEN` | 可选 | `/api/health?detailed=1` 详情令牌 |
| `LOG_QUERIES` | 可选 | `true` 时打印 SQL（仅调试） |
| `NODEJS_HELPERS` | 推荐 | 字面量 `0`（Vercel Hobby 要求） |
| `TZ` | 可选 | 服务器默认时区，默认 `Asia/Shanghai` |
| `CRON_ALLOWED_IPS` | 可选 | 逗号分隔的 Cron 来源 IP 白名单 |
| `HEALTHCHECK_URL` | 可选 | Healthchecks.io 心跳 ping URL |
| `LOG_LEVEL` | 可选 | 日志级别，默认 `info` |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | 可选 | Passkey，与正式域名一致 |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | 可选 | Google 日历只读同步，见 [docs/GOOGLE_CALENDAR_OAUTH.md](docs/GOOGLE_CALENDAR_OAUTH.md) |
| `BLOB_READ_WRITE_TOKEN` | 可选 | 附件对象存储（Vercel Blob）；缺失时生产附件 503 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` | 可选 | Telegram 机器人 webhook |
| `PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` / `PUSH_VAPID_SUBJECT` | 可选 | 浏览器 Web Push（`npx web-push generate-vapid-keys`） |
| `AGENT_WORKER_TOKEN` | 可选 | 本地 Worker 专用凭证（与 `CRON_SECRET` 独立轮换），见 [docs/WORKER.md](docs/WORKER.md) |

> 🔐 **敏感变量切勿勾选 Preview/Development**。预览部署已启用 Vercel Standard Protection，Secret 类变量仅 Production 可避免泄露到预览环境。

### 环境变量（可选：AI / Agent / 后台 AI，默认不配置即关闭相关能力）

| 变量 | 默认 | 说明 |
|------|:----:|------|
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 空 | 云端主用（OpenAI 兼容），见 [docs/AI.md](docs/AI.md) |
| `AI_FALLBACK_BASE_URL` / `AI_FALLBACK_API_KEY` / `AI_FALLBACK_MODEL` | 空 | 云端备用回退 |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `OLLAMA_API_KEY` | 空 | 本地模型；**留空 `OLLAMA_MODEL` 即关闭本地槽位** |
| `EMBEDDINGS_ENABLED` / `EMBEDDINGS_BASE_URL` / `EMBEDDINGS_MODEL` | 关闭 | 语义检索为可选加速，非 `true` 即关闭 |
| `MCP_ENABLED` | `false` | MCP 传输层；非 `true` 即关闭 |
| `AGENT_TOOLS_ENABLED` | 未设置时启用 | 全局 kill switch；`.env.example` 出厂值为 `false` |
| `WORKFLOWS_ENABLED` | 启用 | 后台调度链开关；设为 `false` / `0` / `off` 关闭 |
| `AGENT_MONTHLY_TOKEN_BUDGET` / `AGENT_MONTHLY_CALL_BUDGET` | 不限制 | 每月成本护栏 |
| `AGENT_NOTIFICATION_BUDGET_PER_DAY` | `3` | 每日主动提醒预算 |
| `AGENT_NOTIFICATION_DEDUPE_WINDOW_MS` / `AGENT_ROUTINE_COOLDOWN_MS` | `6h` / `60min` | 反噪音窗口 |

> 后台 AI 的完整架构、免费额度约束与默认值矩阵见 [docs/BACKGROUND_AI.md](docs/BACKGROUND_AI.md)。

---

## ⚙️ 环境变量（本地开发，已废弃 Docker 部署）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TZ` | `Asia/Shanghai` | 时区 |
| `JWT_SECRET` / `MASTER_KEY` | 首次启动自动生成 | 保存到 `data/.env` |
| `DEFAULT_ADMIN_USERNAME` | `admin` | 初始管理员 |
| `DEFAULT_ADMIN_PASSWORD` | 无默认值 | 初始密码（生产必填，≥12 位；首次登录强制修改） |

---

## 🛡️ 安全特性

TimeMark v2.0 内置多层安全防护：

| 特性 | 说明 |
|------|------|
| **自动生成密钥** | 首次启动自动生成随机 JWT_SECRET 和 MASTER_KEY，无需手动配置 |
| **登录失败锁定** | 连续 5 次失败触发锁定，时间线性叠加（5/10/15… 分钟）；**无运维解锁后门**，仅等待到期或正确密码登录 |
| **安全告警** | 触发锁定时，自动通过已配置的通知渠道发送告警通知 |
| **登录日志** | 记录所有登录尝试（成功/失败），含 IP、时间、结果 |
| **JWT 会话管理** | Access Token (15 分钟) + Refresh Token (7 天)，自动续期 |
| **API 限流** | 请求频率限制，防止暴力破解和滥用 |
| **XSS 防护** | 输出转义 + 内容过滤，防止跨站脚本攻击 |
| **密码加密** | bcrypt (cost=10) 哈希存储，不可逆 |
| **凭证加密** | 通知渠道 API Key/Token 使用 AES-256 加密存储 |
| **HTTPS 传输** | 生产环境全站 HTTPS；响应头含 HSTS（Vercel + 应用层） |
| **API 密钥脱敏** | `GET /api/config/accounts` 不返回明文 token/secret，仅 `tokenConfigured` 等标志 |
| **发信白名单** | 联系人快捷发信 `recipientEmails` 必须属于该联系人邮箱列表，禁止任意中继 |
| **CSRF 防护** | 非 GET 请求校验 Origin/Referer；无 Origin 时需 Bearer + `X-Requested-With` |
| **SMTP TLS** | 587 端口强制 `requireTLS`，465 使用 `secure: true` |
| **单用户模式** | 固定个人单账户，禁止创建第二用户 |
| **零信任网关** | 拦截扫描路径与恶意 UA；Cron/Webhook 独立鉴权 |
| **Passkey + Turnstile** | 密码与 Passkey 登录均要求人机验证（启用 Turnstile 时） |
| **SSRF 防护** | 外部日历 URL 拉取前校验公网安全地址 |

安全评估详见 [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)。

---

## 💾 数据备份

Vercel 版使用 PostgreSQL（Neon），推荐通过应用内 **设置 → 数据导出** 导出 JSON，或使用 Neon / Vercel Postgres 控制台做快照备份。

---

## 💻 部署要求

| 项目 | 说明 |
|:----:|------|
| 平台 | Vercel Hobby 或更高 |
| 数据库 | Vercel Postgres / Neon（免费档可用） |
| 域名 | 自定义域名（生产：`timemark.the37777777.top`） |
| Cron | Vercel 内置 `daily-maintenance` + cron-job.org 分钟级任务 |

### 通知与邮件

1. **设置 → 通知默认邮箱** — 填写测试/兜底收件人  
2. **通知渠道 → Resend** — API Key、发件人（可选）、收件人（可留空用默认邮箱）  
3. **测试渠道** → **创建事件 → 测试发送** → 查看提醒日志 / 邮件记录  

详见 [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)。

### 自检显示红色项

**部署向导**检查的是 Vercel 环境变量（非 Resend API Key）。Resend 等渠道凭证在「通知渠道」页配置。Turnstile 为可选项。

---

## 🔧 常见问题

### 忘记管理员密码

在 Vercel Postgres 中重置 `users.password_hash`，或删除用户行后重新运行 `npx tsx scripts/migrate-db.ts`（需 `DEFAULT_ADMIN_PASSWORD`）。

### 换了手机 / 验证器丢了，登不进 TOTP

本项目已支持**恢复码（recovery code）**：启用 2FA 后，在「安全中心 → 双因素认证 → 恢复码」用账号密码 + 当前 6 位验证码签发 10 个（最多 20 个）一次性恢复码。验证器丢失时，在登录页的验证码输入框里填其中一个恢复码（格式 `xxxxx-xxxxx`，大小写/连字符/空格均可）即可登录。注意：

- 恢复码**每个只能用一次**，用掉即从库里移除；剩余数量显示在安全中心。
- 存储的是 SHA-256 哈希，明文只在签发时显示一次，请当场保存。
- **重新签发会作废所有旧码**；关闭 2FA 也会清空全部恢复码。

唯一仍需数据库的情况是恢复码也全部用完/丢失。在 Vercel Postgres 里直接清掉该用户的 TOTP，然后用密码登录、再到安全中心重新绑定：

```sql
UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_recovery_codes = '[]' WHERE username = 'admin';
```

清掉后登录不再要求验证码。绑定新验证器请走「安全中心 → 双因素认证 → 生成二维码」。注意这条 SQL 等于绕过第二因素，只在你确实持有数据库访问权时使用。

### 邮件发不出去 / Resend 测试失败

1. 确认 **设置 → 通知默认邮箱** 或 Resend 渠道 **收件人邮箱** 至少填一处  
2. Resend **API Key** 在通知渠道账户中配置，不是 Vercel 环境变量  
3. 确认 cron-job.org 已配置 `reminder-check`（定时提醒）  

见 [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)。

### Turnstile 不显示

确认 `TURNSTILE_SITE_KEY` 已设且 Production 已 Redeploy。详见 [docs/TURNSTILE_SETUP.md](docs/TURNSTILE_SETUP.md)。

### 通知渠道凭证解密失败

更换 `MASTER_KEY` 后需重新配置通知渠道。`MASTER_KEY` 仅 Production，勿勾选 Preview。

### 构建失败（pnpm）

```powershell
npx pnpm install
npx pnpm build
```

---

## 📝 更新日志

| 版本 | 日期 | 内容 |
|:----:|:----:|------|
| **v2.22.0** | 2026-10-01 | 30 项扩展功能接入（搜索 / Ask / 标签 / 去重 / 今日一览 / 数据健康 / 批量 / 模板 / 智能默认 / 审计 / 自检 / 订阅入库 / 语音 / OCR / 导出 / 分享 / 备份 / 黄历 / 天气 / 包裹）；提醒链路修复（触发日志、跳过原因、补发、时区校验）；**153-160 后端已挂载但缺前端页面，170 端到端验证已部分执行** |
| **v2.21.0** | 2026-09-30 | 后台 AI 运行时：持久化 Postgres 队列、有界 drain、表驱动调度链、模型分档与成本护栏、每日提醒预算、控制面与「AI 后台」页、四个主动例程、决策卡与反馈记忆、可选本地 Worker、运行观测与看门狗 |
| **v2.20.0** | 2026-09-29 | 中国日历增强、周期摘要、目标里程碑、Web Push / PWA、CalDAV 与公开订阅、Telegram 双向机器人、AI 网关与 NL 解析、Agent 工具 / 令牌 / MCP、模式挖掘、pg_trgm 搜索、本地模型、应用内助手 |
| **v2.19.0** | 2026-09-28 | 到期中心、库存与保养、文档保险箱与附件、个人 CRM、习惯打卡、家庭多档案、家庭用药与依从性报告 |
| **v2.18.0** | 2026-09-27 | 依赖大版本升级（React 19.3 / Vite 8.3 / Tailwind 4.3 / Zod 4.6 / Vitest 5.0 / TS 7.0 等）；Service Worker 安全化；i18n 资源加载器；文档矛盾修正；日志与可访问性加固 |
| **v2.17.0** | 2026-09-27 | 渠道真相修复 + 新增 10 个 HTTP 渠道（云端 42：webhook 11 · token 31）+ 渠道矩阵生成；死代码与 exotic 依赖清理；CI 真门禁与工程基线 |
| **v2.16.0** | 2026-07 | 双历/农历修复、NTP 按时区校准、登录加速、单用户模式、提醒 Cron 修复、安全加固（零信任/Passkey Turnstile/SSRF/Webhook） |
| **v2.15.0** | 2026-07 | 联系人多邮箱/手机、待办打勾与完成历史、日历年/月/日视图、安全加固（发信白名单/HSTS/密钥脱敏/SMTP TLS） |
| **v2.14.x** | 2026-07 | Turnstile 修复、深浅色切换、Google OAuth 文档、收件箱全链路、Phase B/C 优化项 |
| **v2.13.0** | 2026-07 | 通知收件人修复、邮件记录与重试队列、Webhook/日历集成、部署向导中文自检 |
| **v2.12.0** | 2026-07 | 最终安全加固：CSP 收紧、日志脱敏、导出脱敏、生产禁弱密钥回退、删除 Docker 遗留、环境变量仅 Production 文档 |
| **v2.11.0** | 2026-07 | 密码登录默认、Turnstile、health 端点加固、Vercel 部署保护 |
| **v2.6.0** | 2026-05 | Vercel Serverless 部署；Neon PostgreSQL；安全加固与渠道兼容性审计 |
| **v2.4.1** | 2026-05 | 修复 Resend 发件人邮箱强制必填；修复 Zod 验证规则；调度器时间匹配优化；事件创建后立即触发提醒 |
| **v2.4.0** | 2026-05 | 通知模板预览（6 种预设模板）；自定义事件模板；浏览器推送 UI；日历导出按钮；重复事件选项；更多事件类型（会议/截止日期/旅行/毕业/婚礼/医疗）；CSRF 保护；API 分页；单元测试 |
| **v2.3.0** | 2026-05 | 自动生成密钥；更多示例事件；渠道测试按钮修复；事件测试发送修复；Resend 发件人修复；时区偏移修复 |
| **v2.2.0** | 2026-05 | 性能优化 + 安全加固 + 功能增强：sql.js 防抖保存（性能提升 10x）；bcrypt 异步化；通知重试机制（3次指数退避）；农历时区修复 + 提醒去重；COALESCE 修复 + chat_id 加密；硬编码密钥检测警告；非 root 容器运行；请求 ID 追踪；统计 API / 备份 API / CSV 导入；API Token 认证；农历智能节日提醒 |
| **v2.1.0** | 2026-04 | 新增 8 个通知渠道（ClawBot/ServerChan/PushPlus/Bark/Gotify/Meow/PushMe/WeComApp）；邮箱多账号选择；登录锁定线性叠加；Docker 依赖修复；零配置即开即用 |
| **v2.0.0** | 2026-04 | 架构重构：PostgreSQL + Redis → SQLite 单容器；零配置即开即用；登录锁定 + 安全告警 + 登录日志；通知凭证 AES 加密；邮箱多账号选择；触发日志 |
| v1.1.1 | 2026-04 | 登录锁定、UI 优化 |
| v1.1.0 | 2025-04 | 提醒多选、农历修复 |
| v1.0.0 | 2025-01 | 初始版本 |

---

## 💬 支持

<div align="center">

**如果对你有帮助，点个 ⭐ Star 支持一下！**

---

🐛 问题反馈：[GitHub Issues](https://github.com/WXFffff666/timemark-vercel/issues)

📖 部署与运维：见 [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)、[docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)、[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

---

Made with ❤️ by TimeMark

</div>
