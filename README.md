# TimeMark Docker

智能事件提醒系统 - 支持农历、多渠道通知、关系映射

## 项目简介

TimeMark 是一个功能完善的事件提醒系统，支持公历/农历双日历、多账户绑定、智能关系映射、测试发送等功能。采用现代化 UI 设计（玻璃态 + 深色模式），数据加密存储，适合个人和家庭使用。

## ✨ 核心功能

### 事件管理
- 📅 **双日历支持** - 公历/农历自动转换，支持闰月
- 🎯 **事件类型** - 生日、考试、纪念日、节日、其他
- 🔔 **灵活提醒** - 支持提前 1/3/7/14/30 天提醒
- 🧪 **测试发送** - 一键测试通知是否正常

### 多渠道通知
- 📧 **邮件** - Resend API 支持
- 💬 **飞书** - Webhook 卡片消息
- 💼 **企业微信** - Markdown 消息
- 📱 **钉钉** - HMAC-SHA256 签名验证
- ✈️ **Telegram** - Bot API 支持
- 🔗 **多账户绑定** - 每个渠道支持绑定多个账户

### 智能模板系统
- 👥 **关系映射** - 自动转换提醒对象（如"我妈"→"妻子"）
- 🎉 **祝贺词库** - 根据事件类型自动添加祝福语
- 📝 **自定义模板** - 支持保存常用模板

### 安全与性能
- 🔐 **数据加密** - AES-256-GCM 加密敏感信息
- 🛡️ **登录保护** - 失败锁定 + 设备指纹识别
- ⚡ **任务队列** - Bull + Redis 高性能调度
- 🐳 **Docker 部署** - 一键启动，占用 < 1GB

## 🚀 快速开始

### Docker 部署（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/WXFffff666/timemark-docker.git
cd timemark-docker

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，配置数据库密码等

# 3. 启动服务
docker-compose up -d

# 4. 访问应用
# 浏览器打开 http://localhost:3000
```

### 本地开发

```bash
# 启动数据库
cd docker && docker-compose up -d postgres redis

# 后端开发
cd backend
npm install
npm run dev

# 前端开发
cd frontend
npm install
npm run dev
```

## 🔑 默认账号

- **用户名**: `admin`
- **密码**: `TimeMark@2026`

⚠️ 首次登录后请立即修改密码

## 📖 使用指南

### 创建事件

1. 点击右下角 ➕ 按钮
2. 选择事件类型（生日/考试/纪念日等）
3. 填写事件详情（标题、日期、农历可选）
4. 设置提醒时间（提前几天）
5. 选择通知渠道和账户

### 配置通知渠道

1. 进入 **设置** → **账户管理**
2. 添加飞书/钉钉/企业微信 Webhook
3. 为每个账户设置名称（如"工作飞书"）
4. 在创建事件时选择对应账户

### 测试通知

- 在事件卡片上点击 **测试发送** 按钮
- 系统会立即发送一次测试通知
- 不影响正常的定时提醒

## 🛠️ 技术栈

**前端**
- React 18 + TypeScript
- Tailwind CSS + Framer Motion
- Zustand (状态管理)
- React Hook Form + Zod

**后端**
- Hono (轻量级 Web 框架)
- PostgreSQL (数据存储)
- Bull + Redis (任务队列)
- Argon2 (密码加密)

**部署**
- Docker + Docker Compose
- 单容器架构，占用 < 1GB
