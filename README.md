# 🕐 TimeMark Docker

<div align="center">

<h1>TimeMark</h1>

<h3>智能事件提醒系统 | 27+通知渠道 | 农历转换 | 关系映射</h3>

---

[![Version](https://img.shields.io/badge/Version-1.1.1-blue?style=flat&color=2563eb)](https://github.com/WXFffff666/timemark-docker)
[![Docker Pulls](https://img.shields.io/docker/pulls/wfffff666/timemark?style=flat&color=0ea5e9)](https://hub.docker.com/r/xxxxxf666/timemark)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat&color=22c55e)](LICENSE)
[![Stars](https://img.shields.io/github/stars/WXFffff666/timemark-docker?style=flat&color=fcd34d)](https://github.com/WXFffff666/timemark-docker/stargazers)

---

[📖 部署文档](DEPLOYMENT.md) · 
[🐛 问题反馈](https://github.com/WXFffff666/timemark-docker/issues) ·
[⭐ Star支持](https://github.com/WXFffff666/timemark-docker/stargazers)

</div>

---

## ✨ 为什么选择 TimeMark？

| 🌙 精准农历 | 🔔 27+渠道 | 👥 智能关系 | 🔐 企业安全 | 🌍 全球时区 |
|:----------:|:-----------:|:-----------:|:----------:|:----------:|
| 闰月转换 | 国内外全覆盖 | 称呼自动映射 | TOTP+JWT | NTP自动同步 |

---

## 🚀 快速部署

### 📦 两个镜像源

| 镜像源 | 拉取命令 | 需要认证 | 说明 |
|--------|----------|:--------:|--------|
| **Docker Hub** (推荐) | `docker pull xxxxxf666/timemark:latest` | ❌ | 无需登录，全球CDN加速 |
| **GHCR** | `docker pull ghcr.io/wfffff666/timemark:latest` | ⚠️ | 可能需要GitHub登录 |

> 💡 **推荐使用 Docker Hub**，无需任何认证即可拉取。

### 📋 一键部署 (Docker Hub)

```bash
# 1. 创建部署目录
mkdir timemark && cd timemark

# 2. 下载配置文件 (二选一)
# Docker Hub (推荐)
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/master/docker-compose.dockerhub.yml -o docker-compose.yml
# 或 GHCR
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/master/docker-compose.ghcr.yml -o docker-compose.yml

# 3. 启动服务
docker compose up -d
```

### 📋 复制粘贴部署

将以下配置复制到 Docker Compose 编辑器中：

```yaml
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
    image: xxxxxf666/timemark:latest  # 或 ghcr.io/wfffff666/timemark:latest
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

---

## ☁️ 平台部署

| 平台 | 配置文件 | 说明 |
|------|---------|------|
| 飞牛OS | `docker-compose.simple.yml` | 简单部署 |
| 群晖NAS | `docker-compose.nas.yml` | NAS专用 |
| 威联通/铁威马 | `docker-compose.nas.yml` | NAS专用 |
| 公网服务器 | `docker-compose.full.yml` | 完整配置 |

详见 [部署文档](DEPLOYMENT.md)

---

## 🔐 首次登录

| 项目 | 默认值 |
|------|--------|
| 🌐 访问地址 | http://服务器IP:3000 |
| 👤 用户名 | `admin` |
| 🔑 密码 | `TimeMark@2026` |

> ⚠️ **安全提示**：首次登录后请立即修改默认密码！

---

## 🎯 核心功能

### 📅 事件类型

| 类型 | 说明 |
|------|------|
| 🎂 生日 | 家人、朋友、同事的生日 |
| 💕 纪念日 | 结婚/恋爱/创业纪念日 |
| 🎉 节日 | 春节/中秋节/情人节 |
| ✨ 自定义 | 任意重要日期 |

### 📆 日历类型

- **公历**：仅显示公历日期
- **农历**：仅显示农历日期
- **双历**：同时显示公历+农历

### ⏰ 提醒配置

- **时间**：08:00 / 09:00 / 12:00 + 自定义
- **提前天数**：1天 / 3天 / 7天 / 14天 / 30天
- **通知渠道**：邮件/微信/钉钉/Telegram等（多选）

### 👥 关系映射

解决称呼不适配问题：

| 原始称呼 | 智能转换 |
|---------|----------|
| 我爸 | 父亲 |
| 我妈 | 妻子 |
| 老公 | 丈夫 |
| 爷爷 | 外公 |

---

## 📢 通知渠道 (27个)

### 官方直连

📧 邮件 · 🏢 飞书 · 💬 企业微信 · 📌 钉钉 · ✈️ Telegram · 💼 Slack · 🎮 Discord · 🟢 WxPusher · 🐧 QMsg

### Webhook集成

WhatsApp · Google Chat · Signal · iMessage · IRC · Microsoft Teams · Matrix · LINE · Mattermost · Nostr · Twitch · Zalo

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────┐
│           用户访问 :3000                 │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                 ▼
   ┌─────────┐       ┌─────────┐
   │  前端   │◄──────►│  后端   │
   │ React  │       │  Hono  │
   └─────────┘       └────┬────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   ┌─────────┐     ┌─────────┐     ┌─────────┐
   │PostgreSQL│     │  Redis │     │  Cron  │
   │  :5432  │     │ :6379  │     │       │
   └─────────┘     └─────────┘     └─────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 🖥️ 前端 | React 18 + TypeScript + TailwindCSS |
| ⚙️ 后端 | Hono + TypeScript + lunar-javascript |
| 🗄️ 数据库 | PostgreSQL 15 + Redis 7 |
| 🔐 认证 | JWT + TOTP |

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 | 必需 |
|------|--------|------|------|
| DB_HOST | postgres | 数据库主机 | ✅ |
| DB_PORT | 5432 | 数据库端口 | ✅ |
| DB_NAME | timemark | 数据库名称 | ✅ |
| DB_USER | timemark | 数据库用户 | ✅ |
| DB_PASSWORD | timemark_pass | 数据库密码 | ✅ |
| REDIS_URL | redis://redis:6379 | Redis地址 | ✅ |
| TZ | Asia/Shanghai | 时区 | ✅ |
| NODE_ENV | production | 环境 | ✅ |
| JWT_SECRET | auto | JWT密钥 | |
| MASTER_KEY | - | 主密钥 | |

---

## 🔒 安全特性

| 特性 | 说明 |
|------|------|
| 🔑 JWT会话 | Access(15分钟) + Refresh(7天) |
| 🔐 登录锁定 | 15分钟5次失败自动锁定 |
| 👀 记住我 | 30天免登录 |
| 📧 ��全告警 | 登录失败/新设备/改密码 |

---

## 📋 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| 🌐 Web | **3000** | 主应用 |
| 🗄️ PostgreSQL | 5432 | 内部 |
| ⚡ Redis | 6379 | 内部 |

---

## 💾 数据备份

```bash
# 手动备份
docker compose down
tar -czf timemark-backup.tar.gz ./data
docker compose up -d

# 自动备份
0 3 * * * cd /opt/timemark && docker compose down && tar -czf /backup/timemark.tar.gz ./data && docker compose up -d
```

---

## 📊 系统要求

| 项目 | 最低 | 推荐 |
|------|------|------|
| 🖥️ CPU | 1核 | 2核 |
| 💾 内存 | 1GB | 2GB |
| 💿 磁盘 | 5GB | 10GB |
| 🐳 Docker | 20.10+ | 20.10+ |

---

## 📝 更新日志

| 版本 | 日期 | 内容 |
|------|------|------|
| v1.1.1 | 2026-04 | 登录锁定、UI优化 |
| v1.1.0 | 2025-04 | 提醒多选、农历修复 |
| v1.0.0 | 2025-01 | 初始版本 |

---

## 🤝 支持

<div align="center">

**如果对你有帮助，点个 ⭐ Star 支持一下！**

Made with ❤️ by TimeMark

---

📧 邮箱: wxf200707@gmail.com  
🐛 问题: https://github.com/WXFffff666/timemark-docker/issues

</div>