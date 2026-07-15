# 开启 Vercel Standard Protection：预览 / *.vercel.app 需 Vercel 账号登录，正式自定义域名保持公开
# 用法: .\scripts\enable-vercel-protection.ps1

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "==> 启用 Vercel Authentication（Standard Protection）"
Write-Host "    效果: timemark.the37777777.top 公开；*.vercel.app 仅团队/本人可访问"
Write-Host ""

npx vercel project protection enable timemark-vercel --sso --format json

if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "CLI 失败时，请在 Vercel 控制台手动开启："
  Write-Host "  项目 timemark-vercel → Settings → Deployment Protection"
  Write-Host "  → Vercel Authentication → Standard Protection（生产自定义域名除外）"
  exit 1
}

Write-Host ""
Write-Host "==> 当前保护设置"
npx vercel project protection timemark-vercel --format json

Write-Host ""
Write-Host "==> 清理多余 vercel.app 别名（保留正式域名）"
& (Join-Path $PSScriptRoot "prune-vercel-aliases.ps1")
