# TimeMark Docker 项目文档

## 项目概述

TimeMark Docker 是一个智能事件提醒系统，支持：
- 公历/农历生日提醒
- 多渠道通知 (27个渠道)
- 关系映射
- TOTP 双因素认证
- JWT 会话管理

## 项目结构

```
timemark-docker/
├── backend/              # 后端服务 (Hono + TypeScript)
│   └── src/
│       ├── routes/       # API 路由
│       │   ├── auth.ts   # 认证相关 (登录, 2FA, 修改密码, Token刷新)
│       │   ├── config.ts # 配置管理 (用户配置, 通知账户, 关系映射)
│       │   └── events.ts # 事件管理 (CRUD)
│       ├── services/     # 业务逻辑
│       │   ├── auth.service.ts
│       │   ├── session.service.ts
│       │   ├── config.service.ts
│       │   ├── event.service.ts
│       │   ├── alert.service.ts   # 安全告警邮件
│       │   └── notifications/    # 通知服务 (27个渠道)
│       │       ├── index.ts       # 分发器
│       │       ├── email.service.ts
│       │       ├── feishu.service.ts
│       │       ├── telegram.service.ts
│       │       ├── discord.service.ts
│       │       ├── slack.service.ts
│       │       ├── wxpusher.service.ts
│       │       ├── qmsg.service.ts
│       │       ├── wecom.service.ts
│       │       ├── dingtalk.service.ts
│       │       └── generic-webhook.service.ts
│       ├── jobs/
│       │   └── tasks.ts  # 定时任务 (农历转换, 提醒触发)
│       ├── queue/        # 队列处理
│       │   ├── scheduler.ts
│       │   ├── queues.ts
│       │   ├── processors.ts
│       │   └── redis.ts
│       ├── utils/
│       │   ├── jwt.ts    # JWT 令牌
│       │   ├── totp.ts  # TOTP 验证码
│       │   ├── password.ts
│       │   └── ntp.ts    # NTP 时间同步
│       ├── middleware/
│       │   └── auth.middleware.ts
│       ├── db/
│       │   └── index.ts
│       └── index.ts      # 入口
├── frontend/            # 前端 (React + TypeScript)
│   └── src/
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx
│       │   ├── Channels.tsx       # 通知渠道配置
│       │   ├── Settings.tsx       # 设置页面
│       │   ├── Reminders.tsx
│       │   └── LoginHistory.tsx
│       ├── components/
│       │   ├── settings/
│       │   │   ├── AccountSettings.tsx    # 通知账户管理
│       │   │   ├── TemplateSettings.tsx
│       │   │   └── RelationshipSettings.tsx # 关系映射
│       │   ├── events/
│       │   │   ├── EventCard.tsx
│       │   │   └── EventForm.tsx
│       │   ├── auth/
│       │   │   └── LoginForm.tsx
│       │   ├── ui/       # UI 组件
│       │   └── TimezoneSelector.tsx
│       ├── lib/
│       │   └── api.ts
│       ├── hooks/
│       │   └── use-toast.ts
│       ├── context/
│       │   └── timezone.tsx
│       └── App.tsx
├── shared/              # 共享类型
│   └── src/
│       ├── types/
│       │   ├── event.types.ts
│       │   ├── auth.types.ts
│       │   └── api.types.ts
│       ├── schemas/
│       │   ├── event.schema.ts
│       │   └── auth.schema.ts
│       ├── blessings.ts  # 祝福语
│       ├── relationship.ts
│       └── crypto.ts
├── docker/
│   ├── init-db.sql      # 数据库初始化
│   └── seed-db.sql      # 种子数据
├── docker-compose.yml   # Docker 编排
├── Dockerfile
├── .dockerignore
└── package.json
```

## 数据库表

| 表名 | 用途 |
|------|------|
| `users` | 用户账户 |
| `sessions` | JWT 会话 |
| `events` | 事件/提醒 |
| `email_logs` | 邮件发送日志 |
| `login_logs` | 登录日志 |
| `login_attempts` | 登录失败追踪 |
| `user_configs` | 用户配置 (加密存储) |
| `notification_accounts` | 通知账户管理 |
| `event_trigger_logs` | 事件触发日志 |
| `relationship_mappings` | 关系映射 |

## API 端点

### 认证 (`/auth`)
| 方法 | 路径 | 功能 |
|------|------|------|
| POST | /login | 用户登录 |
| POST | /verify-2fa | 验证 TOTP |
| POST | /setup-2fa | 获取 TOTP 密钥 |
| POST | /confirm-2fa | 确认并启用 2FA |
| POST | /verify-device | 验证设备 |
| POST | /logout | 登出 |
| POST | /change-password | 修改密码 |
| POST | /refresh | 刷新 Token |

### 事件 (`/events`)
| 方法 | 路径 | 功能 |
|------|------|------|
| GET | / | 获取所有事件 |
| POST | / | 创建事件 |
| PUT | /:id | 更新事件 |
| DELETE | /:id | 删除事件 |

### 配置 (`/config`)
| 方法 | 路径 | 功能 |
|------|------|------|
| GET | / | 获取用户配置 |
| POST | / | 保存用户配置 |
| GET | /accounts | 获取通知账户 |
| POST | /accounts | 创建通知账户 |
| PUT | /accounts/:id | 更新通知账户 |
| DELETE | /accounts/:id | 删除通知账户 |
| GET | /relationships | 获取关系映射 |
| POST | /relationships | 创建关系映射 |
| PUT | /relationships/:id | 更新关系映射 |
| DELETE | /relationships/:id | 删除关系映射 |

## 已实现功能清单

### 通知渠道 (27个)

**官方直连 (9个)**:
- Feishu (飞书)
- WeCom (企业微信)
- DingTalk (钉钉)
- Telegram
- Slack
- Discord
- WxPusher (微信)
- QMsg (QQ)
- Email (Resend API)

**Webhook 桥接 (18个)**:
- WhatsApp
- Google Chat
- Signal
- iMessage
- BlueBubbles
- IRC
- Microsoft Teams
- Matrix
- LINE
- Mattermost
- Nextcloud Talk
- Nostr
- Synology Chat
- Tlon
- Twitch
- Zalo
- Zalo Personal
- 网络聊天

### 已实现功能

| 功能 | 状态 | 文件 |
|------|------|------|
| 农历支持 | ✅ | backend/src/jobs/tasks.ts |
| 农历事件提醒 | ✅ | backend/src/jobs/tasks.ts |
| 密码修改 | ✅ | backend/src/routes/auth.ts |
| Token 刷新 | ✅ | backend/src/routes/auth.ts |
| 账户持久化 | ✅ | backend/src/services/config.service.ts |
| 安全告警邮件 | ✅ | backend/src/services/alert.service.ts |
| 邮件模板 | ✅ | backend/src/services/notifications/email.service.ts |
| 事件触发日志 | ✅ | docker/init-db.sql, backend/src/jobs/tasks.ts |
| 关系映射 | ✅ | shared/src/relationship.ts |
| 时区切换 | ✅ | frontend/src/context/timezone.tsx |
| NTP 同步 | ✅ | backend/src/utils/ntp.ts |
| Docker 优化 | ✅ | docker-compose.yml, .dockerignore |
| 双日历支持 | ✅ | shared/src/types/event.types.ts |
| 自定义提醒时间 | ✅ | shared/src/types/event.types.ts |
| 生日年龄显示 | ✅ | frontend/src/components/events/EventCard.tsx |
| 通知账户管理 | ✅ | frontend/src/components/settings/AccountSettings.tsx |
| 关系映射 UI | ✅ | frontend/src/components/settings/RelationshipSettings.tsx |

## 技术栈

- **后端**: Hono, TypeScript, PostgreSQL, Redis, lunar-javascript
- **前端**: React, TypeScript, TailwindCSS, Framer Motion
- **认证**: JWT, TOTP
- **通知**: Resend (邮件), 各平台 Webhook/Bot API

## 配置说明

### Docker 环境变量

```yaml
# docker-compose.yml
environment:
  - DATABASE_URL=postgresql://...
  - REDIS_URL=redis://...
  - JWT_SECRET=...
  - TZ=Asia/Shanghai
```

### 用户配置键

| 键名 | 类型 | 说明 |
|------|------|------|
| feishu_webhook | string | 飞书 Webhook |
| wecom_webhook | string | 企业微信 Webhook |
| dingtalk_webhook | string | 钉钉 Webhook |
| dingtalk_secret | string | 钉钉密钥 |
| telegram_bot_token | string | Telegram Bot Token |
| telegram_chat_id | string | Telegram Chat ID |
| slack_webhook | string | Slack Webhook |
| discord_webhook | string | Discord Webhook |
| wxpusher_app_token | string | WxPusher AppToken |
| wxpusher_uid | string | WxPusher UID |
| qmsg_key | string | Qmsg Key |
| qmsg_qq | string | Qmsg QQ (可选) |
| resend_api_key | string | Resend API Key |
| reminder_emails | string | 邮件提醒列表 (JSON 数组) |
| channel_webhooks | object | 桥接渠道 Webhook |

## 开发命令

```bash
# 开发
pnpm dev:frontend  # 前端开发服务器
pnpm dev:backend  # 后端开发服务器

# 构建
pnpm build        # 构建全部
pnpm build:frontend
pnpm build:backend
```

## 下次开发注意事项

1. **添加新渠道**:
   - 后端: 在 `backend/src/services/notifications/index.ts` 添加条件判断
   - 前端: 在 `frontend/src/pages/Channels.tsx` 添加配置输入框
   - 状态: 在 `channelStatus` 中添加检测逻辑

2. **数据库变更**:
   - 修改 `docker/init-db.sql`
   - 需要重建数据库容器

3. **前端组件**:
   - UI 组件在 `frontend/src/components/ui/`
   - 页面组件在 `frontend/src/pages/`
   - 使用 `api.ts` 中的 `api.get/post/delete` 方法

4. **后端服务**:
   - 业务逻辑在 `services/`
   - 定时任务在 `jobs/`
   - 队列在 `queue/`
