# TimeMark Docker 🕐

智能事件提醒系统 - 支持生日、纪念日等重要事件的自动化管理

[![Docker Image Size](https://img.shields.io/docker/image-size/wxf200707/timemark)](https://github.com/WXFffff666/timemark-docker/pkgs/container/timemark)
[![Docker Pulls](https://img.shields.io/docker/pulls/wxf200707/timemark)](https://github.com/WXFffff666/timemark-docker/pkgs/container/timemark)

---

## ⭐ 核心特性

| 特性 | 说明 |
|------|------|
| 🌙 农历支持 | 基于 lunar-javascript 库，精准转换，支持闰月 |
| 🔔 27+通知渠道 | 覆盖国内外主流通讯平台 |
| 👥 关系映射 | 自定义称呼转换，如"我爸"→"妻子" |
| 🔐 企业级安全 | JWT会话管理，安全告警，登录锁定 |
| 🌍 时区切换 | 支持全球时区，自动NTP时间同步 |
| 📝 触发日志 | 完整的事件触发记录和日志追踪 |

---

## 🚀 快速部署

### 方式一：使用公开镜像（推荐）

```bash
# 一键启动（需要先安装Docker）
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/master/docker-compose.public.yml -o docker-compose.yml

# 启动所有服务
docker-compose up -d
```

**访问地址**: http://localhost:3000

### 方式二：Docker命令直接启动

```bash
# 1. 创建网络
docker network create timemark 2>/dev/null || true

# 2. 启动数据库
docker run -d \
  --name timemark-postgres \
  --network timemark \
  -e POSTGRES_DB=timemark \
  -e POSTGRES_USER=timemark \
  -e POSTGRES_PASSWORD=timemark_pass \
  -e PGTZ=Asia/Shanghai \
  -v postgres_data:/var/lib/postgresql/data \
  postgres:16-alpine

# 3. 启动缓存
docker run -d \
  --name timemark-redis \
  --network timemark \
  redis:7-alpine redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru

# 4. 启动应用
docker run -d \
  --name timemark-app \
  --network timemark \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e DB_HOST=timemark-postgres \
  -e DB_PORT=5432 \
  -e DB_NAME=timemark \
  -e DB_USER=timemark \
  -e DB_PASSWORD=timemark_pass \
  -e REDIS_URL=redis://timemark-redis:6379 \
  -e TZ=Asia/Shanghai \
  ghcr.io/wxf200707/timemark:latest
```

---

## 🔐 默认账号

| 账号类型 | 用户名 | 密码 |
|----------|--------|------|
| 管理员 | admin | TimeMark@2026 |

> ⚠️ 首次登录后请立即修改默认密码！

---

## 📋 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| 应用 | **3000** | 主应用访问端口（浏览器访问） |
| PostgreSQL | 5432 | 数据库（容器内部） |
| Redis | 6379 | 缓存/队列（容器内部） |

---

## ⚙️ 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| DB_HOST | postgres | 数据库主机名 |
| DB_PORT | 5432 | 数据库端口 |
| DB_NAME | timemark | 数据库名称 |
| DB_USER | timemark | 数据库用户名 |
| DB_PASSWORD | timemark_pass | 数据库密码 |
| REDIS_URL | redis://redis:6379 | Redis连接地址 |
| TZ | Asia/Shanghai | 时区设置 |
| NODE_ENV | production | 运行环境 |
| JWT_SECRET | timemark-secret-key | JWT密钥 |
| MASTER_KEY | - | 主密钥（敏感数据加密）|
| RESEND_API_KEY | - | 邮件发送API (Resend) |
| ALERT_EMAILS | - | 安全告警接收邮箱 |

---

## 📢 支持的通知渠道（27个）

### 官方直连渠道

| 渠道 | 图标 | 配置要求 | 特点 |
|------|------|----------|------|
| 邮件 | 📧 | Resend API Key | 正式邮件，支持HTML模板 |
| 飞书 | 📱 | Webhook URL | 飞书群聊卡片消息 |
| 企业微信 | 💬 | Webhook URL | 企业微信群聊Markdown |
| 钉钉 | 🔔 | Webhook + Secret | 钉钉群聊，HMAC签名 |
| Telegram | ✈️ | Bot Token + Chat ID | Telegram机器人 |
| Slack | 💼 | Webhook URL | Slack频道 |
| Discord | 🎮 | Webhook URL | Discord频道 |
| WxPusher | 💚 | AppToken + UID | 微信公众号推送 |
| Qmsg | 🐧 | Key | QQ机器人通知 |

### Webhook/Token 渠道

| 渠道 | 图标 | 配置要求 |
|------|------|----------|
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
| Synology Chat | 🖥️ | Synology Chat Server |
| Twitch | 📺 | Twitch EventSub |
| Zalo | 💌 | Zalo OA |
| 微信公众号 | 📣 | WxPusher |
| 微信个人号 | 💬 | Wechaty/Puppet |

### 插件渠道

部分渠道需要额外配置插件服务（如 WhatsApp、微信等需要通过 wechaty 或其他服务）

---

## 📖 功能详解

### 事件管理

支持四种事件类型：
- 🎂 **生日** - 家人、朋友生日
- 💕 **纪念日** - 结婚纪念日、恋爱纪念日
- 🎉 **节日** - 春节、中秋节、元旦
- ✨ **其他** - 任意重要日期

### 日历类型

- **公历** - 仅使用公历日期
- **农历** - 仅使用农历日期  
- **双历** - 公历农历都显示

### 提醒配置

- ⏰ **提醒时间**: 预设时间快速选择 + 自定义时间，可多选
- 📅 **提前天数**: 支持提前1/3/7/14/30天提醒
- 📢 **通知渠道**: 可选择多个通知渠道，支持多账号
- 📧 **邮件列表**: 支持邮件提醒，可设置多个收件人

### 关联人员

| 字段 | 说明 | 示例 |
|------|------|------|
| 被提醒人 | 事件所有者/生日主角 | 我爸、妈妈、李四 |
| 提醒人 | 接收通知的人 | 我、妻子、王五 |
| 提醒人邮箱 | 提醒人专属邮箱 | me@example.com |

### 关系映射

解决"给爸爸发妈妈的消息时称呼不适配"的问题：

| 原始称呼 | 转换后 | 适用收件人 |
|----------|--------|------------|
| 我爸 | 父亲 | father类型 |
| 我妈 | 妻子 | wife类型 |
| 老婆 | 妻子 | 通用 |
| 爷爷 | 外公 | 家庭成员映射 |

---

## 🔒 安全特性

### 登录安全
- **JWT会话管理**: Access Token(15分钟) + Refresh Token(7天)
- **登录锁定**: 15分钟内5次失败锁定账户
- **记住我**: 30天免登录

### 安全告警
当账户发生以下情况时自动发送邮件告警：
- 5次连续登录失败
- 新设备登录
- 密码被修改

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户访问                              │
│                   http://localhost:3000                   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                           ▼
┌─────────────────────┐     ┌─────────────────────┐
│      前端           │     │       后端          │
│     React          │◄───►│      Hono          │
│   (静态资源)       │     │   (Node.js)        │
└─────────────────────┘     └─────────┬─────────┘
                                          │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
          ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
          │  PostgreSQL   │     │    Redis     │     │   Cron Job   │
          │   :5432      │     │   :6379      │     │  (定时任务)   │
          └───────────────┘     └───────────────┘     └───────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18, TypeScript, TailwindCSS, Framer Motion |
| 后端 | Hono, TypeScript, lunar-javascript |
| 数据库 | PostgreSQL 15, Redis 7 |
| 认证 | JWT, TOTP |
| 容器 | Docker, Docker Compose |

---

## 📝 更新日志

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| v1.1.1 | 2026-04 | UI优化、通知渠道修复、登录锁定功能 |
| v1.1.0 | 2025-04 | 提醒时间多选、关联人员拆分、农历修复 |
| v1.0.0 | 2025-01 | 初始版本 |

---

## 🤝 支持

- 📮 邮箱：wxf200707@gmail.com
- 🐛 问题反馈：https://github.com/WXFffff666/timemark-docker/issues

---

如果对你有帮助，请点个 Star 支持一下！⭐

Made with ❤️ by TimeMark
