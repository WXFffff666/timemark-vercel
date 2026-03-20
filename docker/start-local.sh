#!/bin/bash
set -e

echo "=== TimeMark 本地测试环境启动 ==="

# 检查 PostgreSQL
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL 未安装"
    exit 1
fi

# 检查 Redis
if ! command -v redis-cli &> /dev/null; then
    echo "❌ Redis 未安装"
    exit 1
fi

# 启动 PostgreSQL（如果未运行）
echo "[1/5] 检查 PostgreSQL..."
if ! pg_isready -h localhost -p 5432 &> /dev/null; then
    echo "启动 PostgreSQL..."
fi

# 启动 Redis（如果未运行）
echo "[2/5] 检查 Redis..."
if ! redis-cli ping &> /dev/null; then
    echo "启动 Redis..."
    redis-server --daemonize yes
fi

# 创建数据库
echo "[3/5] 初始化数据库..."
psql -h localhost -U postgres -c "CREATE DATABASE timemark;" 2>/dev/null || echo "数据库已存在"
psql -h localhost -U postgres -c "CREATE USER timemark WITH PASSWORD 'timemark_password_2026';" 2>/dev/null || echo "用户已存在"
psql -h localhost -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE timemark TO timemark;" 2>/dev/null

# 运行迁移
echo "[4/5] 运行数据库迁移..."
psql -h localhost -U timemark -d timemark -f docker/init-db.sql
psql -h localhost -U timemark -d timemark -f docker/seed-db.sql

# 安装依赖
echo "[5/5] 安装依赖..."
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

echo "✅ 本地环境准备完成！"
echo ""
echo "启动命令："
echo "  后端: cd backend && npm run dev"
echo "  前端: cd frontend && npm run dev"
