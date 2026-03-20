# TimeMark Docker

事件提醒系统 - 本地 Docker 部署版本

## 项目简介

TimeMark 是一个功能强大的事件提醒系统，支持多种通知渠道（邮件、飞书、企业微信、钉钉、Telegram），采用混合加密保护敏感数据。

## 核心功能

- 📅 事件管理（公历/农历）
- 📧 多渠道通知（邮件 + 4个聊天平台）
- 🔐 混合加密（PostgreSQL TDE + AES-256-GCM）
- 🛡️ 登录保护（用户名+IP 锁定）
- ⏰ Bull + Redis 任务队列
- 🐳 Docker 单容器部署

## 快速开始

### 本地开发
```bash
cd docker && start-local.bat
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

### Docker 部署
```bash
cp .env.example .env
docker-compose up -d
```

## 默认账号
- 用户名: admin
- 密码: TimeMark@2026

详见 [DEPLOYMENT.md](./DEPLOYMENT.md)
