# 部署指南

## 系统要求
- Docker 20+
- 内存 2GB+
- 磁盘 10GB+

## 本地开发
1. 启动数据库: `cd docker && start-local.bat`
2. 启动后端: `cd backend && npm run dev`
3. 启动前端: `cd frontend && npm run dev`

## Docker 部署
```bash
cp .env.example .env
# 编辑 .env 设置密钥
docker-compose up -d
```

## 环境变量
必需: DB_PASSWORD, JWT_SECRET, MASTER_KEY

## 数据备份
```bash
docker exec timemark-postgres pg_dump -U timemark timemark > backup.sql
```

详细文档见项目 Wiki
