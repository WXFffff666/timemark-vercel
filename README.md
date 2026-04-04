# TimeMark Docker

智能事件提醒系统

---

## 项目简介

TimeMark Docker 是一款功能强大的智能事件提醒系统，专为管理生日、纪念日等重要事件而设计。系统支持公历和农历双重日历，多渠道实时通知，关系映射，以及企业级安全特性。

### 核心特性

| 特性 | 说明 |
|------|------|
| 农历支持 | 支持公历/农历双重日历，智能转换，支持闰月 |
| 27个通知渠道 | 覆盖国内外主流通讯平台 |
| 关系映射 | 自定义称呼转换，如"我妈"转换为"妻子" |
| 企业级安全 | TOTP双因素认证，JWT会话管理，安全告警邮件 |
| 时区切换 | 支持全球时区，自动NTP时间同步 |
| 触发日志 | 完整的事件触发记录和日志追踪 |

---

## 快速开始

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

# 2. 启动服务（首次启动会自动初始化数据库）
docker-compose up -d

# 3. 访问应用
# 前端: http://localhost:5173
# 后端: http://localhost:3000
# 数据库: localhost:5432
# Redis: localhost:6379
```

### 默认账号

- 用户名: admin
- 密码: TimeMark@2026

注意：首次登录后请立即修改密码

---

## 功能详解

### 事件管理

支持四种事件类型：

| 类型 | 说明 | 示例 |
|------|------|------|
| birthday | 生日 | 家人、朋友生日 |
| anniversary | 纪念日 | 结婚纪念日、恋爱纪念日 |
| holiday | 节日 | 春节、中秋节、元旦 |
| custom | 自定义 | 任意重要日期 |

#### 日历类型

- 公历(gregorian): 仅使用公历日期
- 农历(lunar): 仅使用农历日期  
- 双历(both): 公历农历都显示

#### 提醒配置

每个事件支持灵活的提醒配置：

- 提醒时间：可设置具体的提醒时间（如09:00）
- 提前天数：支持提前1/3/7/14/30天提醒
- 通知渠道：可选择多个通知渠道
- 邮件列表：支持邮件提醒，可设置多个收件人

---

### 通知渠道（共27个）

#### 官方直连渠道（9个）

| 渠道 | 图标 | 配置要求 | 适用场景 |
|------|------|----------|----------|
| 邮件(Resend) | 邮件 | Resend API Key | 正式邮件通知，支持HTML模板 |
| 飞书 | 飞书 | Webhook URL | 飞书群聊卡片消息 |
| 企业微信 | 企业微信 | Webhook URL | 企业微信群聊Markdown消息 |
| 钉钉 | 钉钉 | Webhook + Secret | 钉钉群聊，需HMAC-SHA256签名 |
| Telegram | 电报 | Bot Token + Chat ID | Telegram机器人，支持Markdown |
| Slack | Slack | Webhook URL | Slack频道，支持Blocks格式 |
| Discord | 游戏 | Webhook URL | Discord频道Embed消息 |
| 微信(WxPusher) | 微信 | AppToken + UID | 微信公众号通知 |
| QQ(Qmsg) | QQ | Key | QQ机器人通知 |

#### Webhook桥接渠道（18个）

可通过配置Webhook URL使用的渠道：

WhatsApp、Google Chat、Signal、iMessage、BlueBubbles、IRC、Microsoft Teams、Matrix、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、Zalo Personal、网络聊天

---

### 关系映射功能

关系映射允许你为不同的收件人设置不同的称呼转换，解决了"给爸爸发妈妈的消息时称呼不适配"的问题。

使用场景：
- 你添加了"妈妈生日"事件，称呼为"我妈"
- 给爸爸发送时，转换为"妻子"
- 给妈妈发送时，保持"我妈"
- 给外人发送时，可转换为"母亲"

映射示例：

| 原始称呼 | 转换后 | 适用收件人类型 |
|----------|--------|----------------|
| 我爸 | 父亲 | father类型 |
| 我妈 | 妻子 | wife类型 |
| 老婆 | 妻子 | 通用 |
| 爷爷 | 外公 | 家庭成员映射 |
| 老婆 | 夫人 | 正式场合 |

---

### 安全特性

#### TOTP双因素认证

- 支持Google Authenticator
- 支持Microsoft Authenticator
- 支持任何兼容TOTP的应用（如1Password、Authy等）
- 启用后登录需额外验证动态验证码

#### JWT会话管理

- Access Token：短期令牌，有效期15分钟
- Refresh Token：长期令牌，有效期7天
- 支持设备信任机制
- 支持"记住我"功能

#### 安全告警

当账户发生以下情况时自动发送邮件告警到管理员邮箱：
- 5次连续登录失败
- 新设备登录
- 密码被修改

---

## 系统架构

```
+-------------------+     +-------------------+     +-------------------+
|       前端        |     |       后端        |     |      数据库       |
|     (React)       |<--->|      (Hono)       |<--->|   (PostgreSQL)    |
|     :5173         |     |      :3000        |     |      :5432        |
+-------------------+     +-------------------+     +-------------------+
                                |                          |
                          +-----+-----+              +------+------+
                          |   Redis    |              |   定时任务   |
                          |   :6379    |              |    (Cron)   |
                          +------------+              +-------------+
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

## 本地开发

```bash
# 安装依赖
pnpm install

# 启动数据库服务
cd docker && docker-compose up -d postgres redis

# 后端开发
cd backend
pnpm install
pnpm dev

# 前端开发
cd frontend
pnpm install
pnpm dev

# 构建生产版本
pnpm build
```

---

## 环境配置

### Docker环境变量

```yaml
# 数据库连接
DATABASE_URL=postgresql://timemark:password@postgres:5432/timemark

# Redis连接
REDIS_URL=redis://redis:6379

# JWT密钥（生产环境务必修改）
JWT_SECRET=your-secret-key-change-in-production

# 时区设置（默认东八区）
TZ=Asia/Shanghai

# 邮件服务（可选）
RESEND_API_KEY=re_xxx
ALERT_EMAILS=admin@example.com,support@example.com
```

### 端口映射

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端 | 5173 | Vite开发服务器 |
| 后端 | 3000 | API服务 |
| PostgreSQL | 5432 | 数据库 |
| Redis | 6379 | 缓存/队列 |

---

## API接口文档

### 认证接口 (/auth)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/login | 用户登录 |
| POST | /auth/verify-2fa | 验证TOTP验证码 |
| POST | /auth/setup-2fa | 获取TOTP密钥和二维码 |
| POST | /auth/confirm-2fa | 确认并启用双因素认证 |
| POST | /auth/verify-device | 验证设备信任状态 |
| POST | /auth/logout | 用户登出 |
| POST | /auth/change-password | 修改密码 |
| POST | /auth/refresh | 刷新AccessToken |

### 事件接口 (/events)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /events | 获取当前用户所有事件 |
| POST | /events | 创建新事件 |
| PUT | /events/:id | 更新事件 |
| DELETE | /events/:id | 删除事件 |

### 配置接口 (/config)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /config | 获取用户配置 |
| POST | /config | 保存用户配置 |
| GET | /config/accounts | 获取通知账户列表 |
| POST | /config/accounts | 创建通知账户 |
| PUT | /config/accounts/:id | 更新通知账户 |
| DELETE | /config/accounts/:id | 删除通知账户 |
| GET | /config/relationships | 获取关系映射列表 |
| POST | /config/relationships | 创建关系映射 |
| PUT | /config/relationships/:id | 更新关系映射 |
| DELETE | /config/relationships/:id | 删除关系映射 |

---

## 贡献指南

欢迎提交Issue和Pull Request！

1. Fork本仓库
2. 创建特性分支 git checkout -b feature/功能名称
3. 提交更改 git commit -m 'Add xxx功能'
4. 推送分支 git push origin feature/功能名称
5. 开启Pull Request

---

## 支持

- 问题反馈：https://github.com/WXFffff666/timemark-docker/issues
- 邮箱：wxf200707@gmail.com

---

如果对你有帮助，请点个 Star 支持一下！

Made with love by TimeMark
