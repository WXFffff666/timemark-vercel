# TimeMark Docker 部署指南 🕐

智能事件提醒系统 - 支持27+通知渠道

---

## 📦 部署文件说明

| 文件 | 适用场景 | 特点 |
|------|----------|------|
| `docker-compose.simple.yml` | 飞牛OS、简单部署 | 基础配置，一键部署 |
| `docker-compose.nas.yml` | 群晖/威联通/铁威马 | NAS专用，网络自动创建 |
| `docker-compose.full.yml` | 公网服务器 | 完整配置，含HTTPS占位符 |
| `docker-compose.yml` | 本地开发 | 需要先构建镜像 |

---

## 🚀 快速部署（通用）

### 方式一：复制粘贴部署

将以下内容复制到你的Docker Compose中：

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
    networks:
      - timemark
  redis:
    image: redis:7-alpine
    container_name: timemark-redis
    restart: unless-stopped
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks:
      - timemark
  app:
    image: ghcr.io/wfffff666/timemark:latest
    container_name: timemark-app
    restart: unless-stopped
    ports:
      - "3000:3000"
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
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - timemark
networks:
  timemark:
    driver: bridge
volumes:
  postgres_data:
```

### 方式二：命令行部署

```bash
# 1. 创建部署目录
mkdir timemark && cd timemark

# 2. 下载配置文件
curl -sSL https://ghcr.io/wfffff666/timemark:latest/docker-compose.yml -o docker-compose.yml

# 3. 启动服务
docker-compose up -d
```

---

## 🖥️ 飞牛OS 部署

1. 打开飞牛OS Docker应用
2. 进入"Compose"功能
3. 点击"新建Compose"
4. 复制 `docker-compose.simple.yml` 内容粘贴
5. 根据需要修改端口（默认3000）
6. 点击"部署"

---

## 📟 群晖NAS 部署

### 方法1：Docker Compose UI

1. 打开群晖Docker应用
2. 进入"项目"/"Compose"
3. 点击"新建项目"
4. 复制 `docker-compose.nas.yml` 内容
5. 修改数据路径 `/volume1/docker/timemark/...` 为你的实际路径
6. 创建网络：`docker network create timemark-network`
7. 部署

### 方法2：SSH命令行

```bash
# 1. 创建目录
mkdir -p /volume1/docker/timemark/{postgres,data}

# 2. 下载配置
curl -o docker-compose.yml https://ghcr.io/wfffff666/timemark/latest/docker-compose.nas.yml

# 3. 修改配置（vim/nano）
#    - 将 /volume1/docker/timemark/... 改为你的实际路径

# 4. 部署
sudo docker-compose up -d
```

### 端口说明

| 服务 | 默认端口 | 说明 |
|------|---------|------|
| Web界面 | 3000 | 浏览器访问 |
| PostgreSQL | 5432 | 内部使用 |
| Redis | 6379 | 内部使用 |

---

## 🌐 公网服务器部署（docker-compose.full.yml）

```bash
# 1. 创建目录
mkdir -p /opt/timemark/{data,config}

# 2. 下载配置
cd /opt/timemark
wget https://ghcr.io/wfffff666/timemark/latest/docker-compose.full.yml

# 3. 修改配置
#    - JWT_SECRET: 生产环境密钥
#    - MASTER_KEY: 主密钥
#    - /mnt/timemark/...: 数据存储路径

# 4. 启动
docker-compose up -d

# 5. 配置Nginx反向代理（如需要HTTPS）
```

### HTTPS配置占位符

在 `docker-compose.full.yml` 中已预留Traefik标签，取消注释即可：

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.timemark.rule=Host(`your-domain.com`)"
  - "traefik.http.routers.timemark.tls=true"
```

---

## 🔧 常用配置

### 修改端口

```yaml
ports:
  - "8080:3000"  # 改为8080端口
```

### 数据持久化路径

```yaml
volumes:
  - /your/custom/path:/var/lib/postgresql/data
```

### 修改数据库密码

```yaml
environment:
  POSTGRES_PASSWORD: your_new_password
  DB_PASSWORD: your_new_password
```

---

## 🔐 首次登录

| 项目 | 默认值 |
|------|--------|
| 访问地址 | http://服务器IP:3000 |
| 用户名 | admin |
| 密码 | TimeMark@2026 |

> ⚠️ 首次登录后请立即修改默认密码！

---

## 🔧 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| DB_HOST | postgres | 数据库主机 |
| DB_PORT | 5432 | 数据库端口 |
| DB_NAME | timemark | 数据库名 |
| DB_USER | timemark | 数据库用户 |
| DB_PASSWORD | timemark_pass | 数据库密码 |
| REDIS_URL | redis://redis:6379 | Redis地址 |
| TZ | Asia/Shanghai | 时区 |
| JWT_SECRET | timemark-secret-key | JWT密钥 |
| MASTER_KEY | - | 主密钥（敏感数据加密）|

---

## 📝 数据备份

### 手动备份

```bash
# 停止服务
docker-compose down

# 备份数据目录
tar -czf timemark-backup.tar.gz ./data ./postgres

# 启动服务
docker-compose up -d
```

### 自动备份（定时任务）

```bash
# 每天凌晨3点自动备份
0 3 * * * cd /opt/timemark && docker-compose down && tar -czf /backup/timemark-$(date +%Y%m%d).tar.gz ./data && docker-compose up -d
```

---

## 🔧 常见问题

### Q: 端口被占用

A: 修改 `docker-compose.yml` 中端口：

```yaml
ports:
  - "8888:3000"  # 使用8888端口
```

### Q: 数据库连接失败

A: 检查网络和容器状态：

```bash
docker network ls
docker ps -a
docker logs timemark-app
```

### Q: 忘记密码

A: 重置管理员密码（需要SSH）：

```bash
docker exec -it timemark-postgres psql -U timemark -d timemark -c "UPDATE users SET password_hash='\$2a\$10\$MRqDgkKqsxdy/aEhSUsoy.Y5x.9fN5pItImBgQAK/.uWczeQ8rOeS' WHERE username='admin';"
```

---

## 📞 支持

- 📧 邮箱：wxf200707@gmail.com
- 🐛 问题反馈：https://github.com/WXFffff666/timemark-docker/issues

---

Made with ❤️ by TimeMark