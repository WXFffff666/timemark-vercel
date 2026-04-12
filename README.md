# TimeMark Docker 🕐

<div align="center">

[![Docker Image](https://img.shields.io/docker/vizualization/wxf200707/timemark?style=flat&label=Docker+Image&labelColor=2499f2&color=2499f2)](https://github.com/WXFffff666/timemark-docker/pkgs/container/timemark)
[![Stars](https://img.shields.io/github/stars/WXFffff666/timemark-docker?style=flat&label=Stars&labelColor=fcd34d&color=fcd34d)](https://github.com/WXFffff666/timemark-docker/stargazers)
[![License](https://img.shields.io/github/license/WXFffff666/timemark-docker?style=flat&label=License&labelColor=10b981&color=10b981)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/wxf200707/timemark?style=flat&label=Pulls&labelColor=ef4444&color=ef4444)](https://github.com/WXFffff666/timemark-docker/pkgs/container/timemark)

**智能事件提醒系统 | 支持27+通知渠道 | 农历转换 | 关系映射**

[🏠 主页](https://github.com/WXFffff666/timemark-docker) · [📖 部署文档](DEPLOYMENT.md) · [🐛 问题反馈](https://github.com/WXFffff666/timemark-docker/issues)

</div>

---

## ✨ 为什么选择 TimeMark？

| 特性 | 说明 |
|------|------|
| 🌙 **精准农历** | 基于 lunars-javascript，支持闰月润日期转换 |
| 🔔 **27+通知渠道** | 邮件/微信/钉钉/Telegram/飞书等国内外主流平台 |
| 👥 **智能关系映射** | "我爸"→"父亲"，解决称呼尴尬问题 |
| 🔐 **企业级安全** | JWT会话/TOTP/登录锁定/安全告警 |
| 🌍 **全球时区** | NTP自动同步，支持世界各地时区 |
| 📝 **完整日志** | 每次提醒都有详细记录可追溯 |
| 🐳 **Docker部署** | 一键部署，兼容飞牛OS/群晖/威联通 |

---

## 🚀 5秒快速部署

### 方式一：复制粘贴（推荐）

将以下内容复制到你的Docker Compose编辑器中：

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    container_name: timemark-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: timemark
      POSTGRES_USER: timemark
      POSTGRES_PASSWORD: timemark_pass
      PGTZ: Asia/Shanghai
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U timemark"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [timemark]
  redis:
    image: redis:7-alpine
    container_name: timemark-redis
    restart: unless-stopped
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    networks: [timemark]
  app:
    image: ghcr.io/wxf200707/timemark:latest
    container_name: timemark-app
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      NODE_ENV: production
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: timemark
      DB_USER: timemark
      DB_PASSWORD: timemark_pass
      REDIS_URL: redis://redis:6379
      TZ: Asia/Shanghai
    depends_on:
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
    networks: [timemark]
networks:
  timemark: {driver: bridge}
volumes:
  postgres_data:
```

### 方式二：命令行一键部署

```bash
# 1. 创建部署目录
mkdir timemark && cd timemark

# 2. 下载配置文件
curl -sSL https://ghcr.io/wxf200707/timemark/latest/docker-compose.simple.yml -o docker-compose.yml

# 3. 启动服务（约1-2分钟）
docker-compose up -d
```

### 方式三：飞牛OS/群晖 NAS

详见 [部署文档](DEPLOYMENT.md) - 包含飞牛OS、群晖DSM、威联通QTS、铁威马TOS 详细教程

---

## 🔐 首次登录

| 项目 | 默认值 |
|------|--------|
| 🌐 访问地址 | http://你的服务器IP:3000 |
| 👤 用户名 | `admin` |
| 🔑 密码 | `TimeMark@2026` |

> ⚠️ **安全提示**：首次登录后请立即修改默认密码！

---

## 🎯 核心功能

### 📅 事件管理

```
四种事件类型：
🎂 生日    - 家人、朋友、同事的生日
💕 纪念日 - 结婚纪念日、恋爱纪念日、创业纪念日
🎉 节日    - 春节、中秋节、元旦、情人节
✨ 自定义  - 任意重要日期
```

### 📆 日历类型

```
公历  - 仅显示公历日期（如 2026-01-01）
农历  - 仅显示农历日期（如 农历正月初一）
双历  - 同时显示公历和农历
```

### ⏰ 提醒配置

```
提醒时间   : 08:00 / 09:00 / 12:00 等预设 + 自定义
提前天数   : 1天、3天、7天、14天、30天（可多选）
通知渠道   : 邮件/微信/钉钉/Telegram等（可多选）
```

### 👥 关系映射（核心特色）

解决"给爸爸发妈妈的消息"时称呼不适配的问题：

| 原始称呼 | 智能转换 | 适用场景 |
|---------|----------|----------|
| 我爸 | 父亲 | 给妈妈发送爸爸生日祝福 |
| 我妈 | 妻子 | 给爸爸发送妈妈生日祝福 |
| 老婆 | 妻子 | 通用称呼 |
| 爷爷 | 外公 | 家庭成员映射 |

---

## 📢 支持的通知渠道（27个）

### 🏆 官方直连（无需额外配置）

| 渠道 | 图标 | 配置要求 | 适用场景 |
|------|------|---------|----------|
| 📧 邮件 | Email | Resend API Key | 正式通知、HTML模板 |
| 🏢 飞书 | Feishu | Webhook URL | 飞书群聊卡片 |
| 💬 企业微信 | WeCom | Webhook URL | 企业微信群 Markdown |
| 📌 钉钉 | DingTalk | Webhook + Secret | 钉钉群 HMAC签名 |
| ✈️ Telegram | Telegram | Bot Token + Chat ID | Telegram机器人 |
| 💼 Slack | Slack | Webhook URL | Slack频道 |
| 🎮 Discord | Discord | Webhook URL | Discord频道 |
| 🟢 WxPusher | 微信 | AppToken + UID | 微信公众号推送 |
| 🐧 QMsg | QQ | Key | QQ机器人 |

### 🌐 Webhook/集成

| 渠道 | 图标 | 配置要求 |
|------|------|---------|
| WhatsApp | 📲 | WhatsApp Business API |
| Google Chat | 🔵 | Webhook URL |
| Signal | 🔒 | Signal Service |
| iMessage | 🍎 | BlueBubbles Server |
| IRC | 💻 | IRC Server |
| Microsoft Teams | 📊 | Webhook URL |
| Matrix | ⚡ | Matrix Server |
| LINE | 🟢 | LINE Bot |
| Mattermost | 🧱 | Webhook URL |
| Nextcloud Talk | ☁️ | Nextcloud Server |
| Nostr | 🕸️ | Nostr Relay |
| Synology Chat | 🖥️ | Synology Chat |
| Twitch | 📺 | Twitch EventSub |
| Zalo | 💌 | Zalo OA |

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     🌐 用户访问                             │
│                  https://your-domain.com:3000               │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                           ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│        前端           │     │         后端           │
│       React          │◄───►│        Hono            │
│    (静态资源)        │     │     (Node.js)         │
│       :3000          │     │       :3000           │
└─────────────────────────┘     └───────────┬─────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
          ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
          │   PostgreSQL    │     │      Redis      │     │     Cron       │
          │     :5432       │     │     :6379       │     │   (定时任务)    │
          └─────────────────┘     └─────────────────┘     └─────────────────┘
```

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 🖥️ 前端 | React 18 + TypeScript + TailwindCSS + Framer Motion |
| ⚙️ 后端 | Hono + TypeScript + lunar-javascript |
| 🗄️ 数据库 | PostgreSQL 15 + Redis 7 |
| 🔐 认证 | JWT + TOTP |
| 🐳 容器 | Docker + Docker Compose |

---

## ⚙️ 环境变量

| 变量名 | 默认值 | 说明 | 必需 |
|--------|--------|------|------|
| DB_HOST | postgres | 数据库主机 | ✅ |
| DB_PORT | 5432 | 数据库端口 | ✅ |
| DB_NAME | timemark | 数据库名称 | ✅ |
| DB_USER | timemark | 数据库用户名 | ✅ |
| DB_PASSWORD | timemark_pass | 数据库密码 | ✅ |
| REDIS_URL | redis://redis:6379 | Redis地址 | ✅ |
| TZ | Asia/Shanghai | 时区 | ✅ |
| NODE_ENV | production | 运行环境 | ✅ |
| JWT_SECRET | auto-generated | JWT密钥 | ⚠️ |
| MASTER_KEY | - | 主密钥（敏感数据加密）| ⚠️ |
| RESEND_API_KEY | - | 邮件发送API | 📧 |
| ALERT_EMAILS | - | 安全告警邮箱 | 🔐 |

---

## 🔒 安全特性

### 🛡️ 多层安全保护

| 特性 | 说明 |
|------|------|
| 🔑 JWT会话 | Access Token(15分钟) + Refresh Token(7天) |
| 🔐 登录锁定 | 15分钟内5次失败，自动锁定账户 |
| 👀 记住我 | 30天免登录（可信设备）|
| 📧 安全告警 | 登录失败/新设备/密码修改，自动邮件告警 |

### 📧 安全告警触发条件

```
✓ 5次连续登录失败 → 发送告警邮件
✓ 新设备登录    → 发送告警邮件  
✓ 密码被修改   → 发送告警邮件
```

---

## 📋 端口说明

| 服务 | 端口 | 说明 | 可外部访问 |
|------|------|------|-----------|
| 🌐 Web界面 | **3000** | 主应用端口 | ✅ |
| 🗄️ PostgreSQL | 5432 | 数据库 | ❌ |
| ⚡ Redis | 6379 | 缓存/队列 | ❌ |

---

## 💾 数据备份

```bash
# 手动备份
docker-compose down
tar -czf timemark-backup-$(date +%Y%m%d).tar.gz ./data ./postgres
docker-compose up -d

# 自动备份（每天凌晨3点）
0 3 * * * cd /opt/timemark && docker-compose down && tar -czf /backup/timemark-$(date +%Y%m%d).tar.gz ./data && docker-compose up -d
```

---

## 📊 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|-----------|
| 🖥️ CPU | 1核心 | 2核心 |
| 💾 内存 | 1GB | 2GB |
| 💿 磁盘 | 5GB | 10GB |
| 🐳 Docker | 20.10+ | 20.10+ |
| 🐳 Docker Compose | 2.0+ | 2.0+ |

---

## 📝 更新日志

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| v1.1.1 | 2026-04 | 登录锁定功能、通知渠道修复、UI优化 |
| v1.1.0 | 2025-04 | 提醒时间多选、关联人员拆分、农历修复 |
| v1.0.0 | 2025-01 | 初始版本发布 |

---

## 🤝 支持

<div align="center">

**如果对你有帮助，点个 ⭐ Star 支持一下！**

Made with ❤️ by TimeMark

---
📧 邮箱: wxf200707@gmail.com  
🐛 问题: https://github.com/WXFffff666/timemark-docker/issues  

</div>