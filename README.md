# TimeMark Vercel

<div align="center">

<h1>🎂 TimeMark</h1>

<h3>智能事件提醒系统 | 30+ 通知渠道 | 农历转换 | 关系映射</h3>

<p>一个为生日、纪念日等重要日期打造的全功能提醒系统。<br/>Vercel Serverless 部署，PostgreSQL 数据库，零服务器运维。</p>

---

[![Version](https://img.shields.io/badge/Version-2.15.0-blue?style=flat&color=2563eb)](https://github.com/WXFffff666/timemark-vercel)
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
| 通知渠道 | 43+ 渠道 | **30+ HTTP 渠道（Webhook/Token，云端可用）** |

### 架构优势

- **云原生**：Vercel Serverless Functions + PostgreSQL + Cron Jobs，无需管理服务器
- **全球加速**：前端通过 Vercel Edge Network CDN 分发
- **按需计费**：Vercel Hobby 套餐免费额度足够个人使用
- **自动扩缩**：Serverless 架构自动处理流量高峰
- **持续部署**：连接 GitHub 仓库，推送代码自动部署
- **PostgreSQL**：Vercel Postgres（Neon）提供 0.5GB 免费存储

---

## ✨ 特性一览

| 🗓️ 精准农历 | 📢 多渠道通知 | 👨‍👩‍👧‍👦 智能关系映射 | 🔒 安全防护 | 🌍 全球时区 |
|:----------:|:----------:|:---------------:|:----------:|:--------:|
| 闰月自动转换 | 30+ 通知渠道 | 40+ 称呼映射 | 登录锁定 + 告警 | NTP 自动同步 |
| 公历/农历双历 | 同渠道多账户 | 家庭关系映射 | AES-256 凭证加密 | 自定义时区 |

| 📝 通知模板 | 🔄 重复事件 | 📧 多邮箱支持 | 📅 日历导出 | 🎯 11 种事件类型 |
|:----------:|:----------:|:------------:|:----------:|:---------------:|
| 13 种预设模板 | 每天/每周/每月/每年 | 多收件人邮箱 | ICS 文件导出 | 生日/纪念日/节日等 |
| 按事件类型分组 | 自动创建下次事件 | 联系人多邮箱/手机 | 年/月/日视图 | 会议/旅行/婚礼等 |
| 批量邮件 6 类模板 | 近期待办打勾完成 | 快捷发信可选收件人 | 待办完成历史 | 固定联系人分组 |

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

# 2.1 安装依赖（本地开发必加此参数，否则 baileys 间接依赖会报 ERR_PNPM_EXOTIC_SUBDEP）
pnpm run install:deps
# 等价于：pnpm install --config.blockExoticSubdeps=false

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

部署后数据库表会在 **首次 API 冷启动时自动迁移**（v1–v30）。也可手动执行：

```bash
# 拉取 Vercel 环境变量
vercel env pull .env

# 运行迁移（可选，与自动迁移等效）
npx tsx scripts/migrate-db.ts
```

部署完成后可在 **设置 → 部署向导** 查看「系统自检」（数据库连接、结构版本 v30、CRON_SECRET、Turnstile 等）。

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
| 默认用户名 | `admin` |
| 默认密码 | `TimeMark@2026` |

> ⚠️ **首次登录后请立即修改密码！** 进入设置页面即可修改。

### 详细部署文档

完整的部署指南 → [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)

### 本地开发与装包

本仓库根目录 `.npmrc` 已设置 `blockExoticSubdeps=false`，但部分环境（如通过 `npx pnpm`）仍可能触发 `ERR_PNPM_EXOTIC_SUBDEP`（baileys 的间接依赖含 git 源）。**请始终使用：**

```bash
pnpm run install:deps
# 或
pnpm install --config.blockExoticSubdeps=false
pnpm add <pkg> --config.blockExoticSubdeps=false
```

Vercel 远程构建已在 `vercel.json` 的 `installCommand` 中配置相同参数。

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
│   │  (React SPA) │         │    13 张表 · 索引        │  │
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
| 前端 | React 18 + TypeScript + TailwindCSS + Radix UI | 现代化响应式界面 |
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
| **农历** | 精准农历转换，含闰月自动处理 |
| **双历** | 同时显示公历 + 农历对应日期 |

### 提醒配置

| 配置项 | 可选值 |
|--------|--------|
| 提醒时间 | 06:00 - 22:00 + 自定义任意时间 (可多选) |
| 提前天数 | 1天 / 3天 / 7天 / 14天 / 30天 (可多选) |
| 通知渠道 | 30+ HTTP 渠道任意组合 (可多选) |
| 重复事件 | 每天 / 每周 / 每月 / 每年 |
| 通知模板 | 6 种预设模板 + 自定义模板 |
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

## 📢 通知渠道（云端可用 30+）

TimeMark Vercel 版仅保留 **Webhook / Token 类 HTTP 渠道**（无扫码插件、无长连接 IM）。所有渠道通过「通知账户」统一管理，支持同渠道多账户，创建事件时可选择发送目标。

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

### 💬 即时通讯

| 渠道 | 说明 |
|------|------|
| 📧 邮件 (Resend / SMTP) | 正式邮件通知；Resend 需 API Key + 收件人（或设置默认邮箱） |
| 🔵 飞书 | 飞书群聊机器人 |
| 🟢 企业微信 | 企业微信群聊机器人 |
| 🔷 钉钉 | 钉钉群聊机器人 |
| ✈️ Telegram | Telegram Bot 推送 |
| 💜 Slack | Slack 频道通知 |
| 🟣 Discord | Discord Webhook |
| 📱 WxPusher | 微信公众号推送 |
| 💬 Qmsg | QQ 消息推送 |
| 📡 Server酱 | 微信推送服务（Turbo/V3） |

### 🔗 Webhook 集成

| 渠道 | 说明 |
|------|------|
| Google Chat | Google 工作区通知 |
| IRC | IRC 频道消息 |
| Synology Chat | 群晖 Chat 通知 |
| Twitch | Twitch 频道通知 |
| Mattermost | Mattermost 频道 |
| Nextcloud Talk | Nextcloud 聊天 |
| 通用 Webhook | 自定义 HTTP 回调 |
| PushPlus | 多渠道推送服务 |
| PushMe | 多平台统一推送 |
| Apprise | 统一通知网关 |

### 📱 移动推送

| 渠道 | 说明 |
|------|------|
| Bark | iOS 自定义推送通知 |
| Gotify | 自托管推送服务 |
| 喵推送 (Meow) | 鸿蒙系统推送 |
| 企业微信应用 | 企微应用消息推送 |
| ntfy | 自托管/公共 ntfy 推送 |
| Pushover | Pushover 移动推送 |

### 🌐 协议集成

| 渠道 | 说明 |
|------|------|
| Matrix | 去中心化通讯协议 |
| LINE | LINE 消息推送 |
| Microsoft Teams | Teams 频道通知 |

---

## 🔐 首次登录

| 项目 | 说明 |
|:----:|------|
| 生产地址 | `https://timemark.the37777777.top` |
| 用户名 | `admin`（默认，可由 `DEFAULT_ADMIN_USERNAME` 覆盖） |
| 密码 | 由 `DEFAULT_ADMIN_PASSWORD` 环境变量设定；未自定义时默认为 `TimeMark@2026` |

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
| `DEFAULT_ADMIN_PASSWORD` | 可选 | 初始管理员密码；未设则 `TimeMark@2026` |
| `HEALTH_DETAIL_TOKEN` | 可选 | `/api/health?detailed=1` 详情令牌 |
| `LOG_QUERIES` | 可选 | `true` 时打印 SQL（仅调试） |

> 🔐 **敏感变量切勿勾选 Preview/Development**。预览部署已启用 Vercel Standard Protection，Secret 类变量仅 Production 可避免泄露到预览环境。

---

## ⚙️ 环境变量（本地开发，已废弃 Docker 部署）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TZ` | `Asia/Shanghai` | 时区 |
| `JWT_SECRET` / `MASTER_KEY` | 首次启动自动生成 | 保存到 `data/.env` |
| `DEFAULT_ADMIN_USERNAME` | `admin` | 初始管理员 |
| `DEFAULT_ADMIN_PASSWORD` | `TimeMark@2026` | 初始密码（首次登录强制修改） |

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
npx pnpm install --config.blockExoticSubdeps=false
npx pnpm build --config.blockExoticSubdeps=false
```

---

## 📝 更新日志

| 版本 | 日期 | 内容 |
|:----:|:----:|------|
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
