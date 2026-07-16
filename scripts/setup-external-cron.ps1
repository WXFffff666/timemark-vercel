# 一键配置 cron-job.org 外部 Cron（与 Vercel 内置 daily-maintenance 并存）
#
# 用法:
#   .\scripts\setup-external-cron.ps1 -CronJobOrgApiKey "你的API密钥"
#
# 可选参数:
#   -BaseUrl   默认 https://timemark.the37777777.top
#   -CronSecret  留空则尝试从 .env.production.local 读取 CRON_SECRET
#
# API 密钥获取: https://console.cron-job.org → Settings → API

param(
  [Parameter(Mandatory = $true)]
  [string]$CronJobOrgApiKey,

  [string]$BaseUrl = "https://timemark.the37777777.top",

  [string]$CronSecret = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$apiEndpoint = "https://api.cron-job.org"
$headers = @{
  Authorization = "Bearer $CronJobOrgApiKey"
  "Content-Type" = "application/json"
}

function Get-CronSecretFromEnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path) {
    if ($line -match '^\s*CRON_SECRET\s*=\s*"?([^"\r\n]+)"?\s*$') {
      return $Matches[1].Trim()
    }
  }
  return $null
}

if (-not $CronSecret) {
  Write-Host "==> 尝试读取 CRON_SECRET ..."
  $CronSecret = Get-CronSecretFromEnvFile ".env.production.local"
  if (-not $CronSecret) {
    $CronSecret = Get-CronSecretFromEnvFile ".env.local"
  }
  if (-not $CronSecret) {
    Write-Host "    未找到本地 CRON_SECRET，执行 vercel env pull ..."
    npx vercel env pull .env.production.local --environment=production --yes 2>&1 | Out-Null
    $CronSecret = Get-CronSecretFromEnvFile ".env.production.local"
  }
}

if (-not $CronSecret) {
  throw "无法获取 CRON_SECRET。请传入 -CronSecret 或在 Vercel 中配置后运行 vercel env pull .env.production.local"
}

$base = $BaseUrl.TrimEnd("/")
$authHeaderValue = "Bearer $CronSecret"

$jobsToCreate = @(
  @{
    title = "TimeMark reminder-check"
    path = "/api/cron/reminder-check"
    schedule = @{
      timezone = "Asia/Shanghai"
      expiresAt = 0
      hours = @(-1)
      mdays = @(-1)
      minutes = @(-1)
      months = @(-1)
      wdays = @(-1)
    }
    note = "每分钟 — 必须（与 Vercel daily-maintenance 并存，防重发由服务端处理）"
  },
  @{
    title = "TimeMark retry-notifications"
    path = "/api/cron/retry-notifications"
    schedule = @{
      timezone = "Asia/Shanghai"
      expiresAt = 0
      hours = @(-1)
      mdays = @(-1)
      minutes = @(0, 10, 20, 30, 40, 50)
      months = @(-1)
      wdays = @(-1)
    }
    note = "每 10 分钟 — 重试失败通知"
  }
)

Write-Host "==> 查询 cron-job.org 已有任务 ..."
$existing = Invoke-RestMethod -Uri "$apiEndpoint/jobs" -Headers $headers -Method Get
$existingUrls = @{}
foreach ($j in $existing.jobs) {
  $existingUrls[$j.url] = $j.jobId
}

foreach ($def in $jobsToCreate) {
  $url = "$base$($def.path)"
  Write-Host ""
  Write-Host "==> $($def.title)"
  Write-Host "    $($def.note)"
  Write-Host "    $url"

  if ($existingUrls.ContainsKey($url)) {
    $jobId = $existingUrls[$url]
    Write-Host "    已存在 (jobId=$jobId)，更新调度与 Header ..."
    $body = @{
      job = @{
        enabled = $true
        title = $def.title
        url = $url
        saveResponses = $false
        requestMethod = 0
        requestTimeout = 60
        schedule = $def.schedule
        extendedData = @{
          headers = @{
            Authorization = $authHeaderValue
          }
        }
      }
    } | ConvertTo-Json -Depth 6
    Invoke-RestMethod -Uri "$apiEndpoint/jobs/$jobId" -Headers $headers -Method Patch -Body $body | Out-Null
    Write-Host "    已更新"
    continue
  }

  $body = @{
    job = @{
      enabled = $true
      title = $def.title
      url = $url
      saveResponses = $false
      requestMethod = 0
      requestTimeout = 60
      schedule = $def.schedule
      extendedData = @{
        headers = @{
          Authorization = $authHeaderValue
        }
      }
    }
  } | ConvertTo-Json -Depth 6

  $result = Invoke-RestMethod -Uri "$apiEndpoint/jobs" -Headers $headers -Method Put -Body $body
  Write-Host "    已创建 (jobId=$($result.jobId))"
}

Write-Host ""
Write-Host "==> 完成。当前架构："
Write-Host "    Vercel 内置: daily-maintenance (每天 1 次，vercel.json)"
Write-Host "    cron-job.org: reminder-check (每分钟) + retry-notifications (每 10 分钟)"
Write-Host ""
Write-Host "==> 验证（约 1–2 分钟后）："
Write-Host "    curl $base/api/health"
Write-Host "    期望 lastCronJob = reminder-check，且 lastCronAt 为最近时间"
