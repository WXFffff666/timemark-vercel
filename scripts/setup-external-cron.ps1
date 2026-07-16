# Setup cron-job.org external cron jobs (works alongside Vercel daily-maintenance)
# Usage: .\scripts\setup-external-cron.ps1 -CronJobOrgApiKey "YOUR_API_KEY"
# Optional: -BaseUrl, -CronSecret

param(
  [Parameter(Mandatory = $true)]
  [string]$CronJobOrgApiKey,

  [string]$BaseUrl = 'https://timemark.the37777777.top',

  [string]$CronSecret = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$apiEndpoint = 'https://api.cron-job.org'
$headers = @{
  Authorization  = "Bearer $CronJobOrgApiKey"
  'Content-Type' = 'application/json'
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
  Write-Host '==> Loading CRON_SECRET ...'
  $CronSecret = Get-CronSecretFromEnvFile '.env.production.local'
  if (-not $CronSecret) {
    $CronSecret = Get-CronSecretFromEnvFile '.env.local'
  }
  if (-not $CronSecret) {
    Write-Host '    Running: vercel env pull .env.production.local'
    npx vercel env pull .env.production.local --environment=production --yes 2>&1 | Out-Null
    $CronSecret = Get-CronSecretFromEnvFile '.env.production.local'
  }
}

if (-not $CronSecret) {
  throw 'CRON_SECRET not found. Pass -CronSecret or run: vercel env pull .env.production.local'
}

$base = $BaseUrl.TrimEnd('/')
$authHeaderValue = "Bearer $CronSecret"

$scheduleEveryMinute = @{
  timezone  = 'Asia/Shanghai'
  expiresAt = 0
  hours     = @(-1)
  mdays     = @(-1)
  minutes   = @(-1)
  months    = @(-1)
  wdays     = @(-1)
}

$scheduleEvery10Min = @{
  timezone  = 'Asia/Shanghai'
  expiresAt = 0
  hours     = @(-1)
  mdays     = @(-1)
  minutes   = @(0, 10, 20, 30, 40, 50)
  months    = @(-1)
  wdays     = @(-1)
}

$jobsToCreate = @(
  [PSCustomObject]@{
    Title    = 'TimeMark reminder-check'
    Path     = '/api/cron/reminder-check'
    Schedule = $scheduleEveryMinute
    Note     = 'every minute (required)'
  },
  [PSCustomObject]@{
    Title    = 'TimeMark retry-notifications'
    Path     = '/api/cron/retry-notifications'
    Schedule = $scheduleEvery10Min
    Note     = 'every 10 minutes (retry failed notifications)'
  }
)

Write-Host '==> Fetching existing cron-job.org jobs ...'
$existing = Invoke-RestMethod -Uri "$apiEndpoint/jobs" -Headers $headers -Method Get
$existingUrls = @{}
foreach ($j in $existing.jobs) {
  $existingUrls[$j.url] = $j.jobId
}

foreach ($def in $jobsToCreate) {
  $url = "$base$($def.Path)"
  Write-Host ''
  Write-Host "==> $($def.Title)"
  Write-Host "    $($def.Note)"
  Write-Host "    $url"

  $jobPayload = @{
    enabled        = $true
    title          = $def.Title
    url            = $url
    saveResponses  = $false
    requestMethod  = 0
    requestTimeout = 60
    schedule       = $def.Schedule
    extendedData   = @{
      headers = @{
        Authorization = $authHeaderValue
      }
    }
  }

  if ($existingUrls.ContainsKey($url)) {
    $jobId = $existingUrls[$url]
    Write-Host "    exists (jobId=$jobId), updating ..."
    $body = @{ job = $jobPayload } | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Uri "$apiEndpoint/jobs/$jobId" -Headers $headers -Method Patch -Body $body | Out-Null
    Write-Host '    updated'
    continue
  }

  $body = @{ job = $jobPayload } | ConvertTo-Json -Depth 6 -Compress
  $result = Invoke-RestMethod -Uri "$apiEndpoint/jobs" -Headers $headers -Method Put -Body $body
  Write-Host "    created (jobId=$($result.jobId))"
}

Write-Host ''
Write-Host '==> Done.'
Write-Host '    Vercel built-in: daily-maintenance (once per day)'
Write-Host '    cron-job.org: reminder-check + retry-notifications'
Write-Host ''
Write-Host '==> Verify in 1-2 minutes:'
Write-Host "    $base/api/health"
Write-Host '    expect lastCronJob = reminder-check'
