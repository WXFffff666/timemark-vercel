# TimeMark Docker 部署指南

<div align="center">

### 智能事件提醒系统 | 27+通知渠道 | 农历转换 | 关系映射

</div>

---

## 配置文件总览

| 配置文件 | 适用场景 | 镜像源 | 数据持久化 |
|----------|----------|--------|----------|
| `docker-compose.dockerhub.yml` | 通用部署 (推荐) | Docker Hub | 仅PostgreSQL |
| `docker-compose.ghcr.yml` | 通用部署 | GHCR | 仅PostgreSQL |
| `docker-compose.simple.yml` | 飞牛OS | GHCR | PostgreSQL + 静态文件 |
| `docker-compose.nas.yml` | 群晖/威联通/铁威马 | GHCR | 完整自定义路径 |
| `docker-compose.full.yml` | 公网服务器 | GHCR | 完整配置 + Traefik |
| `docker-compose.public.yml` | 快速测试 | GHCR | 仅PostgreSQL |
| `docker-compose.yml` | 本地开发 | 本地构建 | 完整挂载 |

---

## 镜像拉取方式

TimeMark 镜像托管在 **两个** 平台：

### Docker Hub (推荐)

```bash
# 无需登录，直接拉取
docker pull xfffff666/timemark:latest
```

配置文件：`docker-compose.dockerhub.yml`

### GitHub Container Registry (GHCR)

```bash
# 需要GitHub账号登录
docker login ghcr.io -u 你的用户名 -p 你的GitHubToken

# 拉取镜像
docker pull ghcr.io/wfffff666/timemark:latest
```

配置文件：`docker-compose.ghcr.yml`

> GHCR 拉取可能受限，推荐使用 Docker Hub。

---

## 快速部署

### 方式一：一键命令部署

```bash
# 1. 创建目录
mkdir timemark && cd timemark

# 2. 下载配置文件
# Docker Hub (推荐)
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.dockerhub.yml -o docker-compose.yml

# 或 GHCR
curl -sSL https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.ghcr.yml -o docker-compose.yml

# 3. 启动
docker compose up -d
```

### 方式二：复制粘贴部署

将以下内容复制到 Docker Compose 编辑器：

#### Docker Hub 版本

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
    networks:
      - timemark

  redis:
    image: redis:7-alpine
    container_name: timemark-redis
    restart: unless-stopped
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    dns:
      - 8.8.8.8
      - 1.1.1.1
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks:
      - timemark

  app:
    image: xfffff666/timemark:latest
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
    volumes:
      - ./data:/app/data
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

#### GHCR 版本

只需将上述配置中的 `xxxxx666/timemark:latest` 替换为 `ghcr.io/wfffff666/timemark:latest`

---

## 平台部署指南

### 飞牛OS 部署

1. 打开 **Docker 应用**
2. 进入 **Compose** 功能
3. 点击 **新建Compose**
4. 选择 `docker-compose.dockerhub.yml` 或 `docker-compose.simple.yml`
5. 根据需要修改端口
6. 点击 **部署**

> 飞牛OS 可能需要先登录 GHCR（在SSH中执行 `docker login ghcr.io`）

---

### 群晖NAS 部署

#### 方法1：Docker Compose UI

1. 打开 **Docker** 应用
2. 进入 **项目** / **Compose**
3. 点击 **新建项目**
4. 选择配置文件
5. 修改数据路径 `/volume1/docker/timemark/...`
6. 部署

#### 方法2：SSH命令行

```bash
# 1. 创建目录
mkdir -p /volume1/docker/timemark/{postgres,data}

# 2. 下载NAS配置
curl -o docker-compose.yml https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.nas.yml

# 3. 修改路径
vim docker-compose.yml
# 将 /volume1/docker/timemark/... 改为实际路径

# 4. 部署
sudo docker compose up -d
```

---

### 威联通/铁威马 部署

与群晖类似，使用 `docker-compose.nas.yml`：

```bash
# 1. 创建目录
mkdir -p /share/Container/timemark/{postgres,data}

# 2. 下载配置
curl -o docker-compose.yml https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.nas.yml

# 3. 部署
docker compose up -d
```

---

### 公网服务器部署

使用 `docker-compose.full.yml`：

```bash
# 1. 创建目录
mkdir -p /opt/timemark/{data,config}

# 2. 下载完整配置
cd /opt/timemark
curl -o docker-compose.yml https://raw.githubusercontent.com/WXFffff666/timemark-docker/main/docker-compose.full.yml

# 3. 修改配置
vim docker-compose.yml
# 修改以下内容：
# - JWT_SECRET: 生产环境密钥
# - MASTER_KEY: 主密钥
# - /mnt/timemark/...: 数据存储路径

# 4. 启动
docker compose up -d

# 5. 配置Nginx反向代理（如需要HTTPS）
```

#### HTTPS配置（Traefik）

在 `docker-compose.full.yml` 中取消注释：

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.timemark.rule=Host(`your-domain.com`)"
  - "traefik.http.routers.timemark.tls=true"
```

---

## 常用配置

### 修改端口

```yaml
# docker-compose.yml
ports:
  - "8080:3000"  # 改为8080端口访问
```

### 数据持久化路径

```yaml
# PostgreSQL
volumes:
  - /your/custom/path:/var/lib/postgresql/data

# 静态文件
volumes:
  - ./data:/app/data
```

### 修改数据库密码

```yaml
# PostgreSQL
environment:
  POSTGRES_PASSWORD: your_new_password

# App
environment:
  DB_PASSWORD: your_new_password
```

---

## 首次登录

| 项目 | 默认值 |
|------|--------|
| 访问地址 | http://服务器IP:3000 |
| 用户名 | admin |
| 密码 | TimeMark@2026 |

> 安全提示：首次登录后请立即修改默认密码！

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| DB_HOST | postgres | 数据库主机 |
| DB_PORT | 5432 | 数据库端口 |
| DB_NAME | timemark | 数据库名 |
| DB_USER | timemark | 数据库用户 |
| DB_PASSWORD | timemark_pass | 数据库密码 |
| REDIS_URL | redis://redis:6379 | Redis地址 |
| TZ | Asia/Shanghai | 时区 |
| JWT_SECRET | auto | JWT密钥 |
| MASTER_KEY | - | 主密钥（敏感数据加密） |

---

## 数据备份

### 手动备份

```bash
# 停止服务
docker compose down

# 备份
tar -czf timemark-backup.tar.gz ./data ./postgres

# 启动
docker compose up -d
```

### 自动备份

```bash
# 每天凌晨3点
0 3 * * * cd /opt/timemark && docker compose down && tar -czf /backup/timemark-$(date +%Y%m%d).tar.gz ./data && docker compose up -d
```

---

## 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| Web界面 | 3000 | 浏览器访问 |
| PostgreSQL | 5432 | 内部使用 |
| Redis | 6379 | 内部使用 |

---

## 常见问题

### Q: 端口被占用

A: 修改端口：

```yaml
ports:
  - "8888:3000"
```

### Q: 数据库连接失败

A: 检查网络和容器状态：

```bash
docker network ls
docker ps -a
docker logs timemark-app
```

### Q: 镜像拉取失败

A: 需要登录 GHCR：

```bash
docker login ghcr.io -u 你的用户名 -p 你的GitHubToken
```

### Q: 忘记密码

A: 重置密码：

```bash
docker exec -it timemark-postgres psql -U timemark -d timemark -c "UPDATE users SET password_hash='\$2a\$10\$MRqDgkKqsxdy/aEhSUsoy.Y5x.9fN5pItImBgQAK/.uWczeQ8rOeS' WHERE username='admin';"
```

---

## 支持

- 邮箱: wxf200707@gmail.com
- 问题反馈: https://github.com/WXFffff666/timemark-docker/issues
- Star支持: https://github.com/WXFffff666/timemark-docker/stargazers

---

<div align="center">

Made with love by TimeMark

</div>