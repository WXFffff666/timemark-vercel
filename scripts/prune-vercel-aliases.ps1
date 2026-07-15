# Prune extra Vercel aliases after deploy; keep only the canonical custom domain.
# Usage: .\scripts\prune-vercel-aliases.ps1

$ErrorActionPreference = "Continue"
$canonical = "timemark.the37777777.top"

function Invoke-Vercel {
  param([string[]]$Args)
  $output = & npx --yes vercel @Args --non-interactive 2>&1
  $code = $LASTEXITCODE
  if ($output) { $output | ForEach-Object { Write-Host $_ } }
  return @{ Output = ($output | Out-String); Code = $code }
}

Write-Host "==> Current aliases"
$list = Invoke-Vercel @("alias", "ls")
if ($list.Code -ne 0) {
  Write-Host "Failed to list aliases (exit $($list.Code))"
  exit $list.Code
}

$raw = $list.Output
$lines = $raw -split "`n" | Where-Object { $_ -match "\.vercel\.app|the37777777\.top" }
foreach ($line in $lines) {
  if ($line -notmatch "\s+(https?://)?([^\s]+)\s+") { continue }
  $url = $Matches[2].Trim()
  if ($url -eq $canonical) {
    Write-Host "  keep: $url"
    continue
  }
  if ($url -match "vercel\.app") {
    Write-Host "  remove: $url"
    Invoke-Vercel @("alias", "rm", $url, "--yes") | Out-Null
  }
}

Write-Host "==> After prune"
Invoke-Vercel @("alias", "ls") | Out-Null
