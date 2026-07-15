# 一键写入 Vercel Turnstile 环境变量
# 用法:
#   .\scripts\setup-turnstile.ps1 -SiteKey "0x..." -SecretKey "0x..."
# 或在 Cloudflare 创建好密钥后，按提示粘贴

param(
  [Parameter(Mandatory = $false)]
  [string]$SiteKey,

  [Parameter(Mandatory = $false)]
  [string]$SecretKey
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $SiteKey) {
  $SiteKey = Read-Host "粘贴 TURNSTILE_SITE_KEY (Site Key)"
}
if (-not $SecretKey) {
  $SecretKey = Read-Host "粘贴 TURNSTILE_SECRET_KEY (Secret Key)" -AsSecureString
  $SecretKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecretKey)
  )
}

if ([string]::IsNullOrWhiteSpace($SiteKey) -or [string]::IsNullOrWhiteSpace($SecretKey)) {
  Write-Host "Site Key 与 Secret Key 不能为空"
  exit 1
}

Write-Host "==> 写入 Vercel Production 环境变量"

$SiteKey.Trim() | npx --yes vercel env add TURNSTILE_SITE_KEY production --force 2>&1
if ($LASTEXITCODE -ne 0) {
  $SiteKey.Trim() | npx --yes vercel env add TURNSTILE_SITE_KEY production 2>&1
}

$SecretKey.Trim() | npx --yes vercel env add TURNSTILE_SECRET_KEY production --force 2>&1
if ($LASTEXITCODE -ne 0) {
  $SecretKey.Trim() | npx --yes vercel env add TURNSTILE_SECRET_KEY production 2>&1
}

Write-Host ""
Write-Host "==> 完成。请在 Vercel 重新部署一次，然后访问登录页应出现 Turnstile 组件。"
Write-Host "    验证: https://timemark.the37777777.top/api/health 中 turnstile 应为 true"
