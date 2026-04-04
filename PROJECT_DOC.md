# TimeMark Docker 🕐

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue.svg)
![Tech Stack](https://img.shields.io/badge/tech-Hono%20%2B%20React%20%2B%20TypeScript-orange.svg)

**智能事件提醒系统** | **多渠道通知** | **关系映射** | **双因素认证**

[English](README.md) | [中文](PROJECT_DOC.md)

</div>

---

## 📌 项目简介

TimeMark Docker 是一款功能强大的智能事件提醒系统，专为管理生日、纪念日等重要事件而设计。系统支持公历和农历双重日历，多渠道实时通知，关系映射，以及企业级安全特性。

### ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🌙 农历支持 | 支持公历/农历双重日历，智能转换 |
| 📢 27个通知渠道 | 覆盖国内外主流通讯平台 |
| 👥 关系映射 | 自定义称呼转换 (如"我妈"→"妻子") |
| 🔐 企业级安全 | TOTP双因素认证，JWT会话管理，安全告警 |
| 🌐 时区切换 | 支持全球时区，自动NTP时间同步 |
| 📊 触发日志 | 完整的事件触发记录和日志追踪 |

---

## 🚀 快速开始

### 前置要求

- Docker Engine 20.10+
- Docker Compose 2.0+
- 至少 2GB 可用内存
- 端口 5173, 3000, 5432, 6379 可用

### 一键启动

```bash
# 1. 克隆项目
git clone https://github.com/WXFffff666/timemark-docker.git
cd timemark-docker

# 2. 启动服务 (首次启动会自动初始化数据库)
docker-compose up -d

# 3. 访问应用
# 前端: http://localhost:5173
# 后端: http://localhost:3000
# 数据库: localhost:5432
# Redis: localhost:6379
```

### 首次登录

1. 打开浏览器访问 `http://localhost:5173`
2. 点击注册按钮创建账户
3. 登录后开始添加事件

---

## 📖 功能详解

### 🗓️ 事件管理

#### 支持的事件类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `birthday` | 生日 | 家人、朋友生日 |
| `anniversary` | 纪念日 | 结婚纪念日 |
| `holiday` | 节日 | 春节、中秋节 |
| `custom` | 自定义 | 任意重要日期 |

#### 日历类型

```typescript
type CalendarType = 'gregorian' | 'lunar' | 'both';
// gregorian: 仅公历
// lunar: 仅农历
// both: 公历农历都显示
```

#### 自定义提醒配置

```json
{
  "reminderTime": "09:00",        // 提醒时间
  "reminderDaysBefore": [1, 3, 7], // 提前天数
  "notificationChannels": ["email", "telegram"], // 通知渠道
  "reminderEmails": ["user@example.com"] // 邮件提醒列表
}
```

### 📢 通知渠道 (27个)

#### 官方直连渠道 (9个)

| 渠道 | 图标 | 配置要求 | 适用场景 |
|------|------|----------|----------|
| 📧 Email (Resend) | 📧 | Resend API Key | 正式邮件通知 |
| 🏢 Feishu (飞书) | 🚀 | Webhook URL | 飞书群聊通知 |
| 💬 企业微信 | 💬 | Webhook URL | 企业微信群聊 |
| 📌 DingTalk (钉钉) | 💼 | Webhook + Secret | 钉钉群聊通知 |
| ✈️ Telegram | ✈️ | Bot Token + Chat ID | Telegram机器人 |
| 💼 Slack | 💼 | Webhook URL | Slack频道 |
| 🎮 Discord | 🎮 | Webhook URL | Discord频道 |
| 🟢 WxPusher (微信) | 🟢 | AppToken + UID | 微信公众号通知 |
| 🐧 QMsg (QQ) | 🐧 | Key | QQ机器人通知 |

#### Webhook 桥接渠道 (18个)

| 渠道 | 渠道 | 渠道 | 渠道 |
|------|------|------|------|
| WhatsApp | Google Chat | Signal | iMessage |
| BlueBubbles | IRC | Microsoft Teams | Matrix |
| LINE | Mattermost | Nextcloud Talk | Nostr |
| Synology Chat | Tlon | Twitch | Zalo |
| Zalo Personal | 网络聊天 | | |

#### 配置示例

```yaml
# 通知渠道配置
feishu_webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
telegram_bot_token: "123456789:ABCdefGHIjklMNOpqrsTUV"
telegram_chat_id: "123456789"
slack_webhook: "https://hooks.slack.com/services/xxx"
resend_api_key: "re_xxx"
reminder_emails: ["user@example.com"]
```

### 👥 关系映射

允许你为不同收件人设置不同的称呼转换：

| 原始称呼 | 转换后 | 适用场景 |
|----------|--------|----------|
| 我爸 | 父亲 | 给妈妈发送时 |
| 我妈 | 妻子 | 给爸爸发送时 |
| 老婆 | 妻子 | 统一称呼 |
| 爷爷 | 外公 | 家庭成员映射 |

### 🔐 安全特性

#### TOTP 双因素认证

支持 Google Authenticator、Microsoft Authenticator 等TOTP应用

#### JWT 会话管理

- Access Token: 短期令牌 (15分钟)
- Refresh Token: 长期令牌 (7天)
- 设备信任机制

#### 安全告警

当账户发生以下情况时自动发送邮件告警：
- 5次登录失败
- 新设备登录
- 密码修改

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        TimeMark Docker                       │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │   Frontend   │   │    Backend   │   │   Database   │    │
│  │   (React)    │◄──►│   (Hono)     │◄──►│ (PostgreSQL) │    │
│  │  :5173       │   │    :3000     │   │    :5432     │    │
│  └──────────────┘   └──────────────┘   └──────────────┘    │
│                            │                │               │
│                     ┌──────▼──────┐   ┌──────▼──────┐       │
│                     │    Redis    │   │   Scheduler │       │
│                     │    :6379    │   │   (Cron)    │       │
│                     └─────────────┘   └─────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 🖥️ 前端 | React 18, TypeScript, TailwindCSS, Framer Motion |
| ⚙️ 后端 | Hono, TypeScript, lunar-javascript |
| 🗄️ 数据库 | PostgreSQL 15, Redis 7 |
| 🔐 认证 | JWT, TOTP |
| 🐳 容器 | Docker, Docker Compose |

---

## 📦 项目结构

```
timemark-docker/
├── backend/                    # 后端服务
│   └── src/
│       ├── routes/            # API 路由
│       │   ├── auth.ts         # 认证 (登录/2FA/改密)
│       │   ├── config.ts       # 配置管理
│       │   └── events.ts       # 事件CRUD
│       ├── services/           # 业务逻辑
│       │   ├── notifications/  # 27个通知服务
│       │   ├── alert.service.ts # 安全告警
│       │   └── config.service.ts # 配置服务
│       ├── jobs/              # 定时任务
│       │   └── tasks.ts       # 农历转换/提醒触发
│       ├── queue/             # 消息队列
│       │   ├── scheduler.ts   # 调度器
│       │   └── processors.ts  # 处理器
│       └── utils/            # 工具函数
│           ├── jwt.ts        # JWT令牌
│           ├── totp.ts       # TOTP验证码
│           └── ntp.ts        # NTP同步
│
├── frontend/                  # 前端应用
│   └── src/
│       ├── pages/            # 页面组件
│       │   ├── Dashboard.tsx # 控制台
│       │   ├── Channels.tsx  # 渠道配置
│       │   └── Settings.tsx  # 系统设置
│       ├── components/      # 通用组件
│       │   ├── events/      # 事件组件
│       │   └── settings/    # 设置组件
│       └── context/         # React Context
│           └── timezone.tsx # 时区上下文
│
├── shared/                   # 共享类型
│   └── src/
│       ├── types/           # TypeScript类型
│       ├── schemas/         # Zod验证模式
│       └── blessings.ts     # 祝福语库
│
├── docker/                   # Docker配置
│   ├── init-db.sql         # 数据库初始化
│   └── seed-db.sql         # 种子数据
│
├── docker-compose.yml      # 容器编排
├── Dockerfile              # 应用镜像
└── .dockerignore          # 镜像忽略
```

---

## 🔧 部署配置

### 环境变量

```yaml
# docker-compose.yml
environment:
  # 数据库
  - DATABASE_URL=postgresql://timemark:password@postgres:5432/timemark
  - DATABASE_AUTHENTIFIER=postgresql://timemark:password@postgres:5432/timemark
  
  # Redis
  - REDIS_URL=redis://redis:6379
  
  # JWT
  - JWT_SECRET=your-secret-key-change-in-production
  
  # 时区
  - TZ=Asia/Shanghai
  
  # 邮件 (可选)
  - RESEND_API_KEY=re_xxx
  - ALERT_EMAILS=admin@example.com
```

### 端口映射

| 服务 | 端口 | 说明 |
|------|------|------|
| Frontend | 5173 | Vite 开发服务器 |
| Backend | 3000 | API 服务 |
| PostgreSQL | 5432 | 数据库 |
| Redis | 6379 | 缓存/队列 |

### 性能配置

```yaml
# Docker CPU 限制 (默认 10%)
deploy:
  resources:
    limits:
      cpus: '0.1'  # 限制为单核的10%
```

---

## 💻 操作指南

### 创建事件

1. 登录后进入 Dashboard
2. 点击 "+ 添加事件" 按钮
3. 填写事件信息：
   - 名称 (如: 妈妈生日)
   - 类型 (生日/纪念日/节日/自定义)
   - 日期 (支持农历格式)
   - 日历类型 (公历/农历/双历)
4. 配置提醒：
   - 提醒时间
   - 提前天数 (如: 1, 3, 7天)
   - 通知渠道

### 配置通知渠道

1. 进入 "通知渠道" 页面
2. 选择要配置的渠道类型
3. 填写相应的凭据信息
4. 点击 "保存全部"
5. 状态显示 "已配置" 即表示成功

### 设置关系映射

1. 进入 "设置" 页面
2. 找到 "关系映射设置"
3. 点击 "添加映射"
4. 选择事件、原始称呼、转换后称呼
5. 保存

### 启用双因素认证

1. 进入 "设置" → "安全"
2. 点击 "启用两步验证"
3. 使用认证App扫描二维码
4. 输入验证码确认

---

## 🛠️ 开发指南

### 本地开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev:frontend  # 前端 :5173
pnpm dev:backend  # 后端 :3000

# 构建生产版本
pnpm build
```

### 添加新通知渠道

**后端** (`backend/src/services/notifications/index.ts`):

```typescript
import { sendNewChannelNotification } from './newchannel.service';

// 添加分发逻辑
else if (ch === 'newchannel' && config?.newchannel_key)
  await sendNewChannelNotification(event, config.newchannel_key);
```

**前端** (`frontend/src/pages/Channels.tsx`):

```typescript
// 添加配置输入框
<Input 
  placeholder="NewChannel Key" 
  value={config.newchannel_key || ''} 
  onChange={(e) => updateConfig('newchannel_key', e.target.value)} 
/>

// 添加状态显示
{ name: 'NewChannel', configured: !!config.newchannel_key }
```

### 数据库变更

1. 修改 `docker/init-db.sql`
2. 重建数据库容器:
```bash
docker-compose down -v
docker-compose up -d
```

---

## 📋 API 参考

### 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login` | 用户登录 |
| POST | `/auth/verify-2fa` | 验证TOTP |
| POST | `/auth/setup-2fa` | 获取TOTP密钥 |
| POST | `/auth/confirm-2fa` | 启用2FA |
| POST | `/auth/logout` | 登出 |
| POST | `/auth/change-password` | 修改密码 |
| POST | `/auth/refresh` | 刷新Token |

### 事件接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/events` | 获取所有事件 |
| POST | `/events` | 创建事件 |
| PUT | `/events/:id` | 更新事件 |
| DELETE | `/events/:id` | 删除事件 |

### 配置接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/config` | 获取配置 |
| POST | `/config` | 保存配置 |
| GET | `/config/accounts` | 通知账户 |
| GET | `/config/relationships` | 关系映射 |

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 开源协议

MIT License

Copyright (c) 2024 TimeMark

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## 📞 支持

- 📧 邮箱: wxf200707@gmail.com
- 🐛 问题反馈: https://github.com/WXFffff666/timemark-docker/issues
- 💬 讨论: https://github.com/WXFffff666/timemark-docker/discussions

---

<div align="center">

**如果对你有帮助，请点个 ⭐ Star 支持一下！**

Made with ❤️ by TimeMark

</div>
