# TimeMark Vercel

<div align="center">

<h1>🎂 TimeMark</h1>

<h3>智能事件提醒系统 | 30+ 通知渠道 | 农历转换 | 关系映射</h3>

<p>一个为生日、纪念日等重要日期打造的全功能提醒系统。<br/>Vercel Serverless 部署，PostgreSQL 数据库，零服务器运维。</p>

---

[![Version](https://img.shields.io/badge/Version-2.11.0-blue?style=flat&color=2563eb)](https://github.com/WXFffff666/timemark-vercel)
[![GitHub Stars](https://img.shields.io/github/stars/WXFffff666/timemark-vercel?style=flat&color=f59e0b)](https://github.com/WXFffff666/timemark-vercel/stargazers)
[![Deploy with Vercel](https://img.shields.io/badge/Deploy%20with-Vercel-black?style=flat&logo=vercel)](https://vercel.com/new)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat&color=22c55e)](LICENSE)

---

[📖 免费部署指南](FREE_TIER_DEPLOY.md) · 
[📖 Vercel 完整文档](VERCEL_DEPLOYMENT.md) · 
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
| 按事件类型分组 | 自动创建下次事件 | 调度器每分钟检查 | Google/Apple 日历 | 会议/旅行/婚礼等 |

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

部署后，执行迁移脚本创建数据库表：

```bash
# 拉取 Vercel 环境变量
vercel env pull .env

# 运行迁移
npx tsx scripts/migrate-db.ts
```

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
| 定时任务 | Vercel Cron Jobs | 5 个任务，CRON_SECRET 认证 |
| 认证 | JWT (HS256) | 会话认证 + 登录锁定 |
| 加密 | AES-256 + bcrypt | 凭证加密 + 密码哈希 |
| 部署 | Vercel | 自动部署，全球 CDN，零运维 |

---

## 📋 核心功能

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

### 💬 即时通讯

| 渠道 | 说明 |
|------|------|
| 📧 邮件 (Resend / SMTP) | 正式邮件通知，支持多账号 |
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
| 访问地址 | `http://服务器IP:3000` |
| 用户名 | `admin`（默认） |
| 密码 | `TimeMark@2026`（默认） |

> ⚠️ **首次登录后请立即修改密码！** 进入设置页面即可修改。

---

## ⚙️ 环境变量

> ✅ **所有环境变量均为可选，不设置也能正常使用。** 系统内置默认值，`docker compose up -d` 即可启动。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TZ` | `Asia/Shanghai` | 时区设置（常用自定义项） |
| `DB_PATH` | `/app/data/timemark.db` | SQLite 数据库文件路径 |
| `NODE_ENV` | `production` | 运行环境 |
| `JWT_SECRET` | 首次启动自动生成 | JWT 签名密钥，自动保存到 `data/.env` |
| `MASTER_KEY` | 首次启动自动生成 | 主密钥（通知凭证 AES 加密），自动保存到 `data/.env` |
| `DEFAULT_ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| `DEFAULT_ADMIN_PASSWORD` | `TimeMark@2026` | 初始管理员密码 |
| `LOG_QUERIES` | `false` | 是否打印 SQL 查询日志（调试用） |

> 🔐 **密钥管理说明**：
> - 首次启动时，系统会自动生成随机的 `JWT_SECRET` 和 `MASTER_KEY`
> - 生成的密钥会保存到 `data/.env` 文件中，后续启动会自动读取
> - 如需自定义密钥，可直接设置环境变量或修改 `data/.env` 文件
> - ⚠️ 更换 `MASTER_KEY` 后，已加密的通知渠道凭证需要重新配置

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

---

## 💾 数据备份

SQLite 单文件数据库，备份非常简单。

```bash
# 方式一：在线备份（无需停止容器）
# sql.js 内存数据库定期写入文件，直接复制即可
cp ./data/timemark.db ./data/timemark.db.bak.$(date +%Y%m%d)

# 方式二：完整目录备份
tar -czf timemark-backup-$(date +%Y%m%d).tar.gz ./data

# 方式三：自动定时备份 (crontab)
# 每天凌晨 3 点自动备份
0 3 * * * cd /opt/timemark && tar -czf /backup/timemark-$(date +\%Y\%m\%d).tar.gz ./data
```

### 恢复数据

```bash
# 停止服务
docker compose down

# 恢复备份文件
cp ./data/timemark.db.bak ./data/timemark.db

# 重新启动
docker compose up -d
```

---

## 💻 系统要求

| 项目 | 最低配置 | 推荐配置 |
|:----:|:--------:|:--------:|
| CPU | 1 核 | 2 核 |
| 内存 | 256MB | 512MB |
| 磁盘 | 1GB | 5GB |
| Docker | 20.10+ | 24.0+ |

### 低功耗设备说明

TimeMark v2.0 专门针对低功耗 NAS 处理器做了优化。Intel J4125、N5105 等赛扬/奔腾处理器完全够用。单容器架构相比 v1.x 的三容器方案，内存占用降低约 70%，非常适合家用 NAS 环境。

---

## 🔧 常见问题

### 端口被占用

修改 docker-compose.yml 中的端口映射：

```yaml
ports:
  - "8080:3000"  # 将 3000 改为其他可用端口
```

### 镜像拉取失败

如果使用 GHCR 源，需要先登录：

```bash
docker login ghcr.io -u 你的GitHub用户名 -p 你的GitHubToken
```

推荐切换到 Docker Hub 源，无需登录：`xfffff666/timemark:latest`

### 忘记管理员密码

```bash
# 1. 停止服务
docker compose down

# 2. 删除数据目录（⚠️ 会清除所有数据！请先备份）
rm -rf ./data

# 3. 重新启动（自动创建新数据库）
docker compose up -d
```

### 通知渠道凭证解密失败

如果自定义了 MASTER_KEY 后又更换，之前加密存储的通知渠道凭证将无法解密。需要重新配置所有通知渠道。

### 数据库文件损坏

```bash
# 1. 备份损坏的文件
cp ./data/timemark.db ./data/timemark.db.corrupted

# 2. 如果有备份，恢复备份
cp ./data/timemark.db.bak ./data/timemark.db

# 3. 如果没有备份，删除后重建
rm ./data/timemark.db
docker compose restart
```

---

## 📝 更新日志

| 版本 | 日期 | 内容 |
|:----:|:----:|------|
| **v2.7.0** | 2026-07 | 云端版移除不可用通知渠道（插件/扫码/长连接 IM）；仅保留 Webhook/Token HTTP 渠道；服务端校验 + 登录锁定提示优化 |
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

🐛 问题反馈：[GitHub Issues](https://github.com/WXFffff666/timemark-docker/issues)

📖 部署文档：[DEPLOYMENT.md](DEPLOYMENT.md)

---

Made with ❤️ by TimeMark

</div>
