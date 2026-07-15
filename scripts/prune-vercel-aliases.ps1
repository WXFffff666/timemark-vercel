# 部署后清理多余 Vercel 别名，仅保留正式域名
# 用法: .\scripts\prune-vercel-aliases.ps1

$ErrorActionPreference = "Stop"
$canonical = "timemark.the37777777.top"

Write-Host "==> 当前别名列表"
$raw = npx vercel alias ls 2>&1 | Out-String
Write-Host $raw

$lines = $raw -split "`n" | Where-Object { $_ -match "\.vercel\.app|the37777777\.top" }
foreach ($line in $lines) {
  if ($line -notmatch "\s+(https?://)?([^\s]+)\s+") { continue }
  $url = $Matches[2].Trim()
  if ($url -eq $canonical) {
    Write-Host "  保留: $url"
    continue
  }
  if ($url -match "vercel\.app") {
    Write-Host "  移除: $url"
    npx vercel alias rm $url --yes 2>&1 | Out-Null
  }
}

Write-Host "==> 清理后"
npx vercel alias ls
