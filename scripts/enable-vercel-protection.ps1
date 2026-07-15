# Enable Vercel Standard Protection: preview *.vercel.app requires Vercel login; custom domain stays public.
# Usage: .\scripts\enable-vercel-protection.ps1

$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

function Invoke-Vercel {
  param([string[]]$Args)
  $output = & npx --yes vercel @Args --non-interactive 2>&1
  $code = $LASTEXITCODE
  if ($output) { $output | ForEach-Object { Write-Host $_ } }
  return $code
}

Write-Host "==> Enable Vercel Authentication (Standard Protection)"
Write-Host "    Public: timemark.the37777777.top | Protected: *.vercel.app (team login required)"
Write-Host ""

$enableCode = Invoke-Vercel @("project", "protection", "enable", "timemark-vercel", "--sso", "--format", "json")

if ($enableCode -ne 0) {
  Write-Host ""
  Write-Host "CLI failed. Enable manually in Vercel Dashboard:"
  Write-Host "  Project timemark-vercel -> Settings -> Deployment Protection"
  Write-Host "  -> Vercel Authentication -> Standard Protection (exclude production custom domain)"
  exit 1
}

Write-Host ""
Write-Host "==> Current protection settings"
Invoke-Vercel @("project", "protection", "timemark-vercel", "--format", "json") | Out-Null

Write-Host ""
Write-Host "==> Prune extra vercel.app aliases"
& (Join-Path $PSScriptRoot "prune-vercel-aliases.ps1")
exit $LASTEXITCODE
