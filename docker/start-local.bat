@echo off
echo === TimeMark 本地测试环境启动 ===

REM 检查 PostgreSQL
where psql >nul 2>nul
if %errorlevel% neq 0 (
    echo PostgreSQL 未安装
    exit /b 1
)

REM 检查 Redis
where redis-cli >nul 2>nul
if %errorlevel% neq 0 (
    echo Redis 未安装
    exit /b 1
)

echo [1/5] 启动 PostgreSQL...
net start postgresql-x64-16 >nul 2>nul

echo [2/5] 启动 Redis...
start /B redis-server

echo [3/5] 初始化数据库...
psql -h localhost -U postgres -c "CREATE DATABASE timemark;" 2>nul
psql -h localhost -U postgres -c "CREATE USER timemark WITH PASSWORD 'timemark_password_2026';" 2>nul
psql -h localhost -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE timemark TO timemark;" 2>nul

echo [4/5] 运行数据库迁移...
psql -h localhost -U timemark -d timemark -f docker\init-db.sql
psql -h localhost -U timemark -d timemark -f docker\seed-db.sql

echo [5/5] 安装依赖...
cd backend && call npm install && cd ..
cd frontend && call npm install && cd ..

echo.
echo 本地环境准备完成！
echo.
echo 启动命令：
echo   后端: cd backend ^&^& npm run dev
echo   前端: cd frontend ^&^& npm run dev
