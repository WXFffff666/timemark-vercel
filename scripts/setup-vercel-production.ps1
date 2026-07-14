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

Write-Host "==> 配置 Vercel 环境变量 (Production)"

$vars = @{
  DATABASE_URL = $DatabaseUrl
  CORS_ORIGIN = "https://timemark.the37777777.top,https://timemark-vercel.vercel.app"
  CRON_SECRET = (New-HexSecret 24)
  NODEJS_HELPERS = "0"
  TZ = "Asia/Shanghai"
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

# JWT/MASTER 若不存在则生成
$existing = npx vercel env ls 2>&1 | Out-String
if ($existing -notmatch "JWT_SECRET") {
  $jwt = New-HexSecret 32
  $jwt | npx vercel env add JWT_SECRET production
}
if ($existing -notmatch "MASTER_KEY") {
  $mk = New-HexSecret 32
  $mk | npx vercel env add MASTER_KEY production
}

Write-Host "==> 构建并部署"
npx pnpm install --config.blockExoticSubdeps=false
npx pnpm build
npx vercel deploy --prod --yes

Write-Host "==> 完成。请在 Neon SQL 控制台确认数据库可连，或运行:"
Write-Host "  vercel env pull .env.production"
Write-Host "  npx tsx scripts/migrate-db.ts"
