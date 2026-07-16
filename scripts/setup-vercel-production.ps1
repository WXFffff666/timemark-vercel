# Vercel 生产环境一键配置

# 用法: .\scripts\setup-vercel-production.ps1 -DatabaseUrl "postgresql://..."



param(

  [Parameter(Mandatory = $true)]

  [string]$DatabaseUrl

)



$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")



function New-HexSecret([int]$Bytes = 32) {

  $buf = New-Object byte[] $Bytes

  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)

  return ([BitConverter]::ToString($buf) -replace '-', '').ToLower()

}



Write-Host "==> 配置 Vercel 环境变量 (Production only — 勿勾选 Preview/Development)"



$adminPassword = New-HexSecret 16



$vars = @{

  DATABASE_URL = $DatabaseUrl

  CORS_ORIGIN = "https://timemark.the37777777.top"

  CRONSECRET = (New-HexSecret 24)

  NODEJS_HELPERS = "0"

  TZ = "Asia/Shanghai"

  DEFAULT_ADMIN_USERNAME = "admin"

  DEFAULT_ADMIN_PASSWORD = $adminPassword

}



foreach ($key in $vars.Keys) {

  $val = $vars[$key]

  Write-Host "  设置 $key ..."

  $val | npx vercel env add $key production --force 2>&1 | Out-Null

  if ($LASTEXITCODE -ne 0) {

    Write-Host "  尝试更新 $key (可能已存在)"

    echo $val | npx vercel env add $key production 2>&1

  }

}



# JWT/MASTER 若不存在则生成（仅 Production）

$existing = npx vercel env ls 2>&1 | Out-String

if ($existing -notmatch "JWT_SECRET") {

  $jwt = New-HexSecret 32

  $jwt | npx vercel env add JWT_SECRET production

}

if ($existing -notmatch "MASTER_KEY") {

  $mk = New-HexSecret 32

  $mk | npx vercel env add MASTER_KEY production

}



Write-Host ""

Write-Host "==> 初始管理员（仅显示一次，请妥善保存）"

Write-Host "    Username: admin"

Write-Host "    Password: $adminPassword"

Write-Host "    首次登录将强制修改密码。"

Write-Host ""

Write-Host "==> 敏感变量（JWT_SECRET / MASTER_KEY / TURNSTILE_SECRET_KEY / CRONSECRET）"

Write-Host "    请仅在 Vercel Environment Variables 中勾选 Production，勿勾选 Preview。"



Write-Host "==> 本地构建验证"

npx pnpm install --config.blockExoticSubdeps=false

npx pnpm build



Write-Host "==> 推送 Git 后 Vercel 会自动部署（无需 vercel deploy）"

Write-Host "    git add -A ; git commit -m '...' ; git push origin master"



Write-Host "==> 部署完成后初始化数据库:"

Write-Host "  vercel env pull .env.production"

Write-Host "  npx tsx scripts/migrate-db.ts"

