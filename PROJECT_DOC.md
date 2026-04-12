# TimeMark Docker

<div align="center">

![Version](https://img.shields.io/badge/version-1.1.1-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue.svg)

**智能事件提醒系统** | **多渠道通知** | **关系映射** | **双因素认证**

---

[English](README.md) | [中文](PROJECT_DOC.md)

</div>

---

## 项目简介

TimeMark Docker 是一款功能强大的智能事件提醒系统，专为管理生日、纪念日等重要事件而设计。

### 核心特性

| 特性 | 说明 |
|------|------|
| 农历支持 | 支持公历/农历双重日历，智能闰月转换 |
| 27个通知渠道 | 覆盖国内外主流通讯平台 |
| 关系映射 | 自定义称呼转换 (如"我爸"→"父亲") |
| 企业级安全 | TOTP双因素认证，JWT会话管理 |
| 全球时区 | NTP自动时间同步 |
| 触发日志 | 完整的事件触发记录 |

---

## 快速开始

### 前置要求

- Docker Engine 20.10+
- Docker Compose 2.0+
- 2GB 可用内存
- 端口 3000 可用

### 镜像拉取方式

| 镜像源 | 拉取地址 | 需要认证 |
|--------|----------|:--------:|
| **Docker Hub** (推荐) | `xfffff666/timemark:latest` | 否 |
| **GHCR** | `ghcr.io/wfffff666/timemark:latest` | 是 |

### 一键启动

```bash
# 1. 创建目录
mkdir timemark && cd timemark

# 2. 下载配置 (二选一)
# Docker Hub (推荐)
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.dockerhub.yml -o docker-compose.yml

# GHCR
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.ghcr.yml -o docker-compose.yml

# 3. 启动
docker compose up -d

# 4. 访问
# http://localhost:3000
# 账号: admin
# 密码: TimeMark@2026
```

---

## 系统架构

```
+------------------------------------------------------------------+
|                         TimeMark 架构图                           |
+------------------------------------------------------------------+
|                                                                   |
|    +-------------------------------------------------------------+ |
|    |                        :3000                                | |
|    |                        Web UI                                | |
|    +--------------------------+------------------------------------+ |
|                             |                                     |
|                             v                                     |
|    +-------------------------------------------------------------+ |
|    |                      Hono API                               | |
|    |                  +------------+                           | |
|    |                  |  /events   |  事件管理            | |
|    |                  |  /auth    |  认证授权            | |
|    |                  |  /config  |  配置管理            | |
|    |                  |  /notify |  通知分发            | |
|    |                  +------------+                           | |
|    +--------------------------+------------------------------------+ |
|                             |                                     |
|           +-----------------+-----------------+                     |
|           |                 |                 |                     |
|           v                 v                 v                   |
|    +----------+     +----------+     +----------+                |
|    |  :5432  |     |  :6379  |     |  Cron   |                |
|    |PostgreSQL     |  Redis   |    |Scheduler            |
|    +----------+     +----------+     +----------+                |
|                                                                   |
+------------------------------------------------------------------+
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18, TypeScript, TailwindCSS |
| 后端 | Hono, TypeScript, lunar-javascript |
| 数据库 | PostgreSQL 15, Redis 7 |
| 认证 | JWT, TOTP |

---

## 功能详解

### 事件类型

| 类型 | 说明 |
|------|------|
| birthday | 生日 |
| anniversary | 纪念日 |
| holiday | 节日 |
| custom | 自定义 |

### 日历类型

```typescript
type CalendarType = 'gregorian' | 'lunar' | 'both';
// gregorian: 仅公历
// lunar: 仅农历
// both: 公历农历都显示
```

### 提醒配置

```json
{
  "reminderTime": "09:00",
  "reminderDaysBefore": [1, 3, 7],
  "notificationChannels": ["email", "telegram"],
  "reminderEmails": ["user@example.com"]
}
```

---

## 通知渠道 (27个)

### 官方直连 (9个)

| 渠道 | 说明 |
|------|------|
| Email (Resend) | 正式邮件通知 |
| 飞书 | 飞书群聊通知 |
| 企业微信 | 企业微信群聊 |
| 钉钉 | 钉钉群聊通知 |
| Telegram | Telegram机器人 |
| Slack | Slack频道 |
| Discord | Discord频道 |
| WxPusher | 微信公众号通知 |
| QMsg | QQ机器人通知 |

### Webhook集成 (18个)

WhatsApp / Google Chat / Signal / iMessage / IRC / Microsoft Teams / Matrix / LINE / Mattermost / Nostr / Twitch / Zalo / 等

---

## 关系映射

| 原始称呼 | 转换后 | 说明 |
|---------|--------|------|
| 我爸 | 父亲 | 给妈妈发送时 |
| 我妈 | 妻子 | 给爸爸发送时 |
| 老婆 | 妻子 | 统一称呼 |
| 爷爷 | 外公 | 家庭成员映射 |

---

## 安全特性

### TOTP 双因素认证

支持 Google Authenticator、Microsoft Authenticator 等TOTP应用

### JWT 会话管理

- Access Token: 15分钟
- Refresh Token: 7天
- 设备信任机制

### 安全告警

- 5次登录失败告警
- 新设备登录告警
- 密码修改告警

---

## 项目结构

```
timemark-docker/
├── backend/
│   └── src/
│       ├── routes/         # API路由
│       │   ├── auth.ts    # 认证
│       │   ├── config.ts  # 配置
│       │   └── events.ts # 事件
│       ├── services/      # 业务逻辑
│       │   └── notifications/ # 通知服务
│       ├── jobs/         # 定时任务
│       └── utils/        # 工具函数
│
├── frontend/
│   └── src/
│       ├── pages/        # 页面
│       └── components/   # 组件
│
├── shared/               # 共享类型
├── docker/              # Docker配置
├── docker-compose*.yml   # 多种部署配置
└── README.md
```

---

## 部署配置

### 配置文件说明

| 文件 | 适用场景 |
|------|----------|
| docker-compose.dockerhub.yml | 通用 (推荐) |
| docker-compose.ghcr.yml | 通用 |
| docker-compose.simple.yml | 飞牛OS |
| docker-compose.nas.yml | 群晖/威联通/铁威马 |
| docker-compose.full.yml | 公网服务器 |
| docker-compose.yml | 本地开发 |

### 环境变量

```yaml
environment:
  # 数据库
  - DB_HOST=postgres
  - DB_PORT=5432
  - DB_NAME=timemark
  - DB_USER=timemark
  - DB_PASSWORD=timemark_pass

  # Redis
  - REDIS_URL=redis://redis:6379

  # JWT
  - JWT_SECRET=your-secret-key

  # 时区
  - TZ=Asia/Shanghai
```

---

## 操作指南

### 创建事件

1. 登录后进入 Dashboard
2. 点击 "+ 添加事件"
3. 填写事件信息
4. 配置提醒

### 配置通知渠道

1. 进入 "通知渠道"
2. 选择渠道类型
3. 填写凭���信��
4. 保存

### 启用双因素认证

1. 进入 "设置" → "安全"
2. 点击 "启用两步验证"
3. 扫描二维码
4. 输入验证码

---

## 开发指南

### 本地开发

```bash
# 安装依赖
pnpm install

# 启动开发
pnpm dev:frontend  # 前端 :5173
pnpm dev:backend   # 后端 :3000

# 构建
pnpm build
```

---

## API 接口

### 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/login | 登录 |
| POST | /auth/verify-2fa | 验证TOTP |
| POST | /auth/setup-2fa | 获取TOTP密钥 |
| POST | /auth/logout | 登出 |
| POST | /auth/change-password | 修改密码 |

### 事件接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /events | 获取所有事件 |
| POST | /events | 创建事件 |
| PUT | /events/:id | 更新事件 |
| DELETE | /events/:id | 删除事件 |

### 配置接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /config | 获取配置 |
| POST | /config | 保存配置 |

---

## 数据备份

### 手动备份

```bash
docker compose down
tar -czf timemark-backup.tar.gz ./data
docker compose up -d
```

### 自动备份

```bash
0 3 * * * cd /opt/timemark && docker compose down && tar -czf /backup/timemark.tar.gz ./data && docker compose up -d
```

---

## 常见问题

### Q: 端口被占用

修改 docker-compose.yml 中的端口映射

### Q: 数据库连接失败

```bash
docker network ls
docker logs timemark-app
```

### Q: 镜像拉取失败

需要登录 GHCR：
```bash
docker login ghcr.io -u 用户名 -p Token
```

---

## 开源协议

MIT License

---

## 支持

- 邮箱: wxf200707@gmail.com
- 问题反馈: https://github.com/WXFffff666/timemark-docker/issues

---

<div align="center">

**如果对你有帮助，请点个 Star 支持一下！**

Made with love by TimeMark

</div>