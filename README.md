# TimeMark Docker

<div align="center">

<h1>TimeMark</h1>

<h3>智能事件提醒系统 | 27+通知渠道 | 农历转换 | 关系映射</h3>

---

[![Version](https://img.shields.io/badge/Version-2.0.0-blue?style=flat&color=2563eb)](https://github.com/WXFffff666/timemark-docker)
[![Docker Pulls](https://img.shields.io/docker/pulls/wfffff666/timemark?style=flat&color=0ea5e9)](https://hub.docker.com/r/xfffff666/timemark)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat&color=22c55e)](LICENSE)

---

[部署文档](DEPLOYMENT.md) | 
[问题反馈](https://github.com/WXFffff666/timemark-docker/issues) |
[Star支持](https://github.com/WXFffff666/timemark-docker/stargazers)

</div>

---

## v2.0 新特性

| 特性 | v1.x | v2.0 |
|:----:|:----:|:----:|
| 数据库 | PostgreSQL + Redis | **SQLite (内置)** |
| 容器数量 | 3个 | **1个** |
| 内存占用 | ~800MB | **~256MB** |
| 部署复杂度 | 需配置数据库 | **开箱即用** |
| 安全加固 | 基础 | **JWT校验 + 限流 + XSS防护** |

---

## 特性一览

| 精准农历 | 多渠道通知 | 智能关系映射 | 企业级安全 | 全球时区 |
|:--------:|:---------:|:------------:|:---------:|:--------:|
| 闰月自动转换 | 27个通知渠道 | 称呼智能适配 | TOTP+JWT双认证 | NTP自动同步 |

---

## 快速部署

### 镜像拉取方式

| 镜像源 | 拉取地址 | 是否需要登录 | 推荐场景 |
|--------|----------|:----------:|:---------:|
| **Docker Hub** (推荐) | `xfffff666/timemark:latest` | 否 | 个人/家庭 |
| **GHCR** | `ghcr.io/wfffff666/timemark:latest` | 是 (GitHub) | 开发者/企业 |

> **推荐使用 Docker Hub**，无需任何认证即可拉取。

### 一键部署

```bash
# 1. 创建部署目录
mkdir timemark && cd timemark

# 2. 下载配置文件 (二选一)
# Docker Hub (推荐)
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.dockerhub.yml -o docker-compose.yml

# 或 GHCR
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.ghcr.yml -o docker-compose.yml

# 3. 修改配置（⚠️ 必须修改默认密码和密钥！）
vim docker-compose.yml

# 4. 启动服务
docker compose up -d
```

### 配置文件说明

| 文件名 | 适用平台 | 镜像源 | 特点 |
|--------|---------|--------|------|
| `docker-compose.dockerhub.yml` | 通用 | Docker Hub | 即拉即用，无需认证 |
| `docker-compose.ghcr.yml` | 通用 | GHCR | 需要GitHub登录 |
| `docker-compose.simple.yml` | 飞牛OS | GHCR | 轻量部署 |
| `docker-compose.nas.yml` | 群晖/威联通/铁威马 | GHCR | NAS专用配置 |
| `docker-compose.full.yml` | 公网服务器 | GHCR | 完整生产配置 + Traefik |

---

## 系统架构

```
┌──────────────────────────────────────────┐
│              TimeMark v2.0               │
│          单容器 · 零依赖部署              │
├──────────────────────────────────────────┤
│                                          │
│   ┌──────────┐      ┌──────────────┐    │
│   │  :3000   │      │  SQLite DB   │    │
│   │  Web UI  │      │  (WAL mode)  │    │
│   └────┬─────┘      └──────┬───────┘    │
│        │                   │             │
│        │   ┌───────────┐   │             │
│        └──>│  Hono API │<──┘             │
│            └─────┬─────┘                 │
│                  │                       │
│     ┌────────────┼────────────┐          │
│     │            │            │          │
│  ┌──┴───┐  ┌────┴────┐  ┌───┴────┐     │
│  │Croner│  │ Static  │  │ Alert  │     │
│  │ Cron │  │ Files   │  │Service │     │
│  └──────┘  └─────────┘  └────────┘     │
│                                          │
└──────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + TailwindCSS + Radix UI |
| 后端 | Hono + TypeScript + lunar-javascript |
| 数据库 | SQLite 3 (sql.js / WAL mode) |
| 定时任务 | Croner (内置，替代 Redis + Bull) |
| 认证 | JWT (HS256) + TOTP (2FA) |

---

## 核心功能

### 事件管理

| 类型 | 说明 |
|------|------|
| 生日 | 家人、朋友、同事的生日 |
| 纪念日 | 结婚/恋爱/创业纪念日 |
| 节日 | 春节/中秋节/情人节 |
| 自定义 | 任意重要日期 |

### 日历支持

- **公历** — 标准公历日期
- **农历** — 精准农历转换（含闰月）
- **双历** — 同时显示公历 + 农历

### 提醒配置

- **提醒时间**：08:00 / 09:00 / 12:00 + 自定义
- **提前天数**：1天 / 3天 / 7天 / 14天 / 30天
- **通知渠道**：邮件/微信/钉钉/Telegram等（多选）

### 关系映射

智能转换称呼适配不同通知对象：

| 原始称呼 | 智能转换 |
|---------|---------|
| 我爸 | 父亲 |
| 我妈 | 母亲 |
| 老公 | 丈夫 |
| 爷爷 | 外公 |

---

## 通知渠道 (27个)

### 官方直连 (9个)

邮件 / 飞书 / 企业微信 / 钉钉 / Telegram / Slack / Discord / WxPusher / QMsg

### Webhook集成 (18个)

WhatsApp / Google Chat / Signal / iMessage (BlueBubbles) / IRC / Microsoft Teams / Matrix / LINE / Mattermost / Nostr / Twitch / Zalo / Synology Chat / NextCloud Talk / QQ Bot / Generic Webhook / WeChat (OpenClaw) / WeChat (Wechaty)

---

## 首次登录

| 项目 | 说明 |
|------|--------|
| 访问地址 | `http://服务器IP:3000` |
| 用户名 | docker-compose 中 `DEFAULT_ADMIN_USERNAME` 设置的值 |
| 密码 | docker-compose 中 `DEFAULT_ADMIN_PASSWORD` 设置的值 |

> **安全提示**：首次登录后请立即修改密码并启用 2FA！

---

## 环境变量

| 变量 | 默认值 | 说明 | 必需 |
|------|--------|------|:----:|
| `DB_PATH` | `/app/data/timemark.db` | SQLite 数据库路径 | 是 |
| `TZ` | `Asia/Shanghai` | 时区 | 是 |
| `NODE_ENV` | `production` | 运行环境 | 是 |
| `JWT_SECRET` | - | JWT 签名密钥（至少32位随机字符串） | **是** |
| `MASTER_KEY` | - | 主密钥（敏感数据加密） | 否 |
| `DEFAULT_ADMIN_USERNAME` | `admin` | 初始管理员用户名 | 是 |
| `DEFAULT_ADMIN_PASSWORD` | - | 初始管理员密码（请使用强密码） | **是** |

---

## 安全特性

| 特性 | 说明 |
|------|------|
| JWT 会话 | Access Token (15分钟) + Refresh Token (7天) |
| 密钥校验 | JWT_SECRET 最小32字符，生产环境强制检查 |
| 登录锁定 | 5次失败自动锁定15分钟 |
| 限流保护 | API 请求频率限制 |
| XSS 防护 | 输出转义 + 内容过滤 |
| 密码加密 | bcrypt (cost=10) |
| 2FA | TOTP 双因素认证 |
| 数据加密 | 通知账户凭证 AES 加密存储 |

---

## 数据备份

```bash
# 手动备份（SQLite 单文件，非常简单）
docker compose down
cp ./data/timemark.db ./data/timemark.db.bak
docker compose up -d

# 完整备份
tar -czf timemark-backup-$(date +%Y%m%d).tar.gz ./data

# 自动备份 (crontab)
0 3 * * * cd /opt/timemark && tar -czf /backup/timemark-$(date +\%Y\%m\%d).tar.gz ./data
```

---

## 系统要求

| 项目 | 最低 | 推荐 |
|------|------|------|
| CPU | 1核 (J4125 可用) | 2核 |
| 内存 | 256MB | 512MB |
| 磁盘 | 1GB | 5GB |
| Docker | 20.10+ | 24.0+ |

---

## 更新日志

| 版本 | 日期 | 内容 |
|------|------|------|
| **v2.0.0** | 2026-04 | 架构重构：PostgreSQL+Redis → SQLite 单容器；安全加固；触发日志 API |
| v1.1.1 | 2026-04 | 登录锁定、UI优化 |
| v1.1.0 | 2025-04 | 提醒多选、农历修复 |
| v1.0.0 | 2025-01 | 初始版本 |

---

## 支持

<div align="center">

**如果对你有帮助，点个 Star 支持一下！**

Made with love by TimeMark

---

问题反馈: https://github.com/WXFffff666/timemark-docker/issues

</div>