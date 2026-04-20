# TimeMark Docker

<div align="center">

<h1>🎂 TimeMark</h1>

<h3>智能事件提醒系统 | 27+ 通知渠道 | 农历转换 | 关系映射</h3>

<p>一个为生日、纪念日等重要日期打造的全功能提醒系统。<br/>单容器部署，开箱即用，支持飞牛OS / 群晖 / 威联通 / 铁威马等 NAS 平台。</p>

---

[![Version](https://img.shields.io/badge/Version-2.0.0-blue?style=flat&color=2563eb)](https://github.com/WXFffff666/timemark-docker)
[![Docker Pulls](https://img.shields.io/docker/pulls/xfffff666/timemark?style=flat&color=0ea5e9)](https://hub.docker.com/r/xfffff666/timemark)
[![Docker Image Size](https://img.shields.io/docker/image-size/xfffff666/timemark/latest?style=flat&color=6366f1)](https://hub.docker.com/r/xfffff666/timemark)
[![GitHub Stars](https://img.shields.io/github/stars/WXFffff666/timemark-docker?style=flat&color=f59e0b)](https://github.com/WXFffff666/timemark-docker/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/WXFffff666/timemark-docker?style=flat&color=10b981)](https://github.com/WXFffff666/timemark-docker/commits/master)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat&color=22c55e)](LICENSE)

---

[📖 部署文档](DEPLOYMENT.md) · 
[🐛 问题反馈](https://github.com/WXFffff666/timemark-docker/issues) · 
[⭐ Star 支持](https://github.com/WXFffff666/timemark-docker/stargazers)

</div>

---

## 🚀 v2.0 重大更新

v2.0 是一次彻底的架构重构，从三容器方案精简为单容器部署，同时大幅强化了安全性和性能。

| 对比项 | v1.x | v2.0 |
|:------:|:----:|:----:|
| 数据库 | PostgreSQL + Redis | **SQLite (内置，零配置)** |
| 容器数量 | 3 个 | **1 个** |
| 内存占用 | ~800MB | **~256MB** |
| 部署复杂度 | 需配置数据库连接 | **开箱即用** |
| 安全加固 | 基础认证 | **登录锁定 + JWT + 限流 + XSS 防护** |
| 通知账户 | 明文存储 | **AES 加密存储** |
| 多账户支持 | 单渠道单账户 | **同渠道多账户** |
| 定时任务 | Redis + Bull | **Croner (内置)** |

### v2.0 核心改进

- **架构精简**：去掉 PostgreSQL 和 Redis 依赖，SQLite 内置数据库，单容器即可运行
- **即开即用**：零配置启动，所有环境变量均有内置默认值，`docker compose up -d` 即可运行
- **安全加固**：登录失败锁定 + 安全告警 + 登录日志 + 通知凭证 AES 加密存储
- **性能优化**：内存占用降低 70%，启动速度提升，适合 J4125 等低功耗 NAS 处理器
- **多账户通知**：所有通知渠道（含邮箱）统一通过账户管理，支持同渠道多账户多选
- **触发日志**：完整记录每次提醒的触发时间、渠道、结果，方便排查问题

---

## ✨ 特性一览

| 🗓️ 精准农历 | 📢 多渠道通知 | 👨‍👩‍👧‍👦 智能关系映射 | 🔒 安全防护 | 🌍 全球时区 |
|:----------:|:----------:|:---------------:|:----------:|:--------:|
| 闰月自动转换 | 27+ 通知渠道 | 称呼智能适配 | 登录锁定 + 告警 | NTP 自动同步 |
| 公历/农历双历 | 同渠道多账户 | 家庭关系映射 | AES 凭证加密 | 自定义时区 |

---

## ⚡ 快速部署

> 只需 3 步，60 秒完成部署。

### 镜像拉取方式

| 镜像源 | 拉取地址 | 需要登录 | 推荐场景 |
|:------:|----------|:--------:|:--------:|
| **Docker Hub** (推荐) | `xfffff666/timemark:latest` | 否 | 个人 / 家庭 / NAS |
| **GHCR** | `ghcr.io/wfffff666/timemark:latest` | 是 (GitHub) | 开发者 / 企业 |

> 💡 **推荐 Docker Hub**，无需任何认证即可拉取。

### 一键部署

```bash
# 1. 创建目录
mkdir timemark && cd timemark

# 2. 下载配置
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/master/docker-compose.dockerhub.yml -o docker-compose.yml

# 3. 启动（就这么简单，不需要改任何配置）
docker compose up -d
```

部署完成！访问 `http://服务器IP:3000`

| 项目 | 值 |
|:----:|:--:|
| 默认用户名 | `admin` |
| 默认密码 | `TimeMark@2026` |

> ⚠️ **首次登录后请立即修改密码！** 进入设置页面即可修改。

### 配置文件说明

| 文件名 | 适用平台 | 镜像源 | 特点 |
|--------|:-------:|:------:|------|
| `docker-compose.dockerhub.yml` | 通用 | Docker Hub | 即拉即用，无需认证，**推荐** |
| `docker-compose.simple.yml` | 飞牛OS / NAS | Docker Hub | 最简配置 |
| `docker-compose.nas.yml` | 群晖/威联通/铁威马 | Docker Hub | NAS 专用，自定义存储路径 |
| `docker-compose.full.yml` | 公网服务器 | Docker Hub | 生产配置，含资源限制 |
| `docker-compose.ghcr.yml` | 通用 | GHCR | 需要 GitHub 登录，备用 |

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────┐
│                 TimeMark v2.0                    │
│            单容器 · 零依赖 · 开箱即用             │
├─────────────────────────────────────────────────┤
│                                                  │
│   ┌───────────┐       ┌────────────────────┐    │
│   │  :3000    │       │    SQLite DB        │    │
│   │  Web UI   │       │  sql.js (内存数据库  │    │
│   │  (React)  │       │  + 文件持久化)       │    │
│   └─────┬─────┘       └─────────┬──────────┘    │
│         │                       │                │
│         │    ┌──────────────┐   │                │
│         └───>│   Hono API   │<──┘                │
│              │  (TypeScript) │                    │
│              └──────┬───────┘                    │
│                     │                            │
│      ┌──────────────┼──────────────┐             │
│      │              │              │             │
│  ┌───┴────┐   ┌─────┴─────┐  ┌────┴─────┐      │
│  │ Croner │   │  Static   │  │  Alert   │      │
│  │  Cron  │   │  Files    │  │ Service  │      │
│  │ (定时)  │   │ (前端资源) │  │ (通知分发) │      │
│  └────────┘   └───────────┘  └──────────┘      │
│                                                  │
└─────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 | 说明 |
|:----:|------|------|
| 前端 | React 18 + TypeScript + TailwindCSS + Radix UI | 现代化响应式界面 |
| 后端 | Hono + TypeScript + lunar-javascript | 轻量高性能 API 框架 |
| 数据库 | SQLite 3 (sql.js / 内存数据库 + 文件持久化) | 纯 JS 实现，零外部依赖 |
| 定时任务 | Croner | 内置调度器，替代 Redis + Bull |
| 认证 | JWT (HS256) | 会话认证 + 登录锁定 |
| 加密 | AES-256 + bcrypt | 凭证加密 + 密码哈希 |

> 💡 **关于 sql.js**：sql.js 是 SQLite 的纯 JavaScript/WASM 实现，数据库完全在内存中运行，通过定期写入文件实现持久化。无需安装原生 SQLite，跨平台兼容性极佳。

---

## 📋 核心功能

### 事件管理

| 类型 | 说明 | 示例 |
|:----:|------|------|
| 🎂 生日 | 家人、朋友、同事的生日 | 妈妈的生日 (农历八月十五) |
| 💍 纪念日 | 结婚/恋爱/创业纪念日 | 结婚五周年 |
| 🎊 节日 | 传统节日和特殊日期 | 春节、中秋节、情人节 |
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
| 提醒时间 | 08:00 / 09:00 / 12:00 + 自定义任意时间 |
| 提前天数 | 1天 / 3天 / 7天 / 14天 / 30天 (可多选) |
| 通知渠道 | 27+ 渠道任意组合 (可多选) |

### 关系映射

智能转换称呼，让通知内容更自然：

| 原始称呼 | 智能转换 | 场景 |
|:--------:|:--------:|------|
| 我爸 | 父亲 | 发送给其他家庭成员时 |
| 我妈 | 母亲 | 发送给其他家庭成员时 |
| 老公 | 丈夫 | 统一正式称呼 |
| 爷爷 | 外公 | 家庭关系自动映射 |

---

## 📢 通知渠道 (27+)

TimeMark 支持 27+ 通知渠道，覆盖国内外主流通讯平台。所有渠道（含邮箱）统一通过「通知账户」管理，支持同渠道多账户配置，创建事件时可选择发送给哪些账户。

### 💬 即时通讯 (9 个)

| 渠道 | 说明 |
|------|------|
| 📧 邮件 (Resend) | 正式邮件通知，支持多账号选择 |
| 🔵 飞书 | 飞书群聊机器人 |
| 🟢 企业微信 | 企业微信群聊机器人 |
| 🔷 钉钉 | 钉钉群聊机器人 |
| ✈️ Telegram | Telegram Bot 推送 |
| 💜 Slack | Slack 频道通知 |
| 🟣 Discord | Discord Webhook |
| 📱 WxPusher | 微信公众号推送 |
| 💬 Qmsg | QQ 消息推送 |

### 🔗 Webhook 集成 (8 个)

| 渠道 | 说明 |
|------|------|
| Google Chat | Google 工作区通知 |
| IRC | IRC 频道消息 |
| Synology Chat | 群晖 Chat 通知 |
| Twitch | Twitch 频道通知 |
| Mattermost | Mattermost 频道 |
| Nextcloud Talk | Nextcloud 聊天 |
| 通用 Webhook | 自定义 HTTP 回调 |

### 🌐 协议集成 (5 个)

| 渠道 | 说明 |
|------|------|
| Matrix | 去中心化通讯协议 |
| LINE | LINE 消息推送 |
| Microsoft Teams | Teams 频道通知 |
| Nostr | 去中心化社交协议 |
| WhatsApp | WhatsApp 消息 |

### 🔌 插件渠道 (5 个)

| 渠道 | 说明 |
|------|------|
| 微信个人号 (OpenClaw) | 微信个人消息 |
| 微信个人号 (Wechaty) | 微信个人消息 (Wechaty 方案) |
| QQ Bot | QQ 机器人 |
| Signal | Signal 加密消息 |
| iMessage (BlueBubbles) | Apple iMessage |
| Zalo | 越南 Zalo 消息 |

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
| `JWT_SECRET` | 内置默认值 | JWT 签名密钥，公网部署建议自定义 |
| `MASTER_KEY` | 内置默认值 | 主密钥（通知凭证 AES 加密），公网部署建议自定义 |
| `DEFAULT_ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| `DEFAULT_ADMIN_PASSWORD` | `TimeMark@2026` | 初始管理员密码 |
| `LOG_QUERIES` | `false` | 是否打印 SQL 查询日志（调试用） |

> 💡 **公网部署建议**：自定义 `JWT_SECRET` 和 `MASTER_KEY` 以增强安全性。更换 MASTER_KEY 后，已加密的通知渠道凭证需要重新配置。

---

## 🛡️ 安全特性

TimeMark v2.0 内置多层安全防护：

| 特性 | 说明 |
|------|------|
| **登录失败锁定** | 连续 5 次失败触发锁定，锁定时间线性叠加（5/10/15/20... 分钟） |
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
