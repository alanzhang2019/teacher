<#
  status_all.ps1 — 一键查看整套开发环境状态
#>

$ErrorActionPreference = 'SilentlyContinue'
$Root    = 'D:\AItrade\openmaic'
$RepoDir = Join-Path $Root 'OpenMAIC'
$VoxDir  = Join-Path $Root 'VoxCPM'

function Show-Status($label, $port, $pattern) {
  $p = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($p) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.OwningProcess)" -ErrorAction SilentlyContinue
    $cmdShort = ($proc.CommandLine -split '\s+')[0..5] -join ' '
    Write-Host ("  {0,-20} port {1,-5} PID={2,-6} {3}" -f $label, $port, $p.OwningProcess, $cmdShort) -ForegroundColor Green
  }
  else {
    Write-Host ("  {0,-20} port {1,-5} DOWN" -f $label, $port) -ForegroundColor Red
  }
}

Write-Host "=== OpenMAIC dev stack ===" -ForegroundColor Cyan
Show-Status "Next.js dev"   3000
Show-Status "VoxCPM server" 8000

Write-Host ""
Write-Host "=== watchdog 状态 ===" -ForegroundColor Cyan
$wds = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*watchdog.ps1*' }
if ($wds) {
  foreach ($w in $wds) {
    Write-Host "  watchdog PID=$($w.ProcessId)" -ForegroundColor Green
  }
} else {
  Write-Host "  watchdog 未运行" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== server.py 状态 ===" -ForegroundColor Cyan
$srv = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*VoxCPM*server.py*' }
if ($srv) {
  foreach ($s in $srv) {
    Write-Host "  server.py PID=$($s.ProcessId)" -ForegroundColor Green
  }
} else {
  Write-Host "  server.py 未运行" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== /health 探活 ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -UseBasicParsing -TimeoutSec 5
  Write-Host "  /health  → HTTP $($r.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host "  /health  → FAIL: $($_.Exception.Message)" -ForegroundColor Red
}
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/_debug_env' -UseBasicParsing -TimeoutSec 5
  Write-Host "  /api/_debug_env  → HTTP $($r.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host "  /api/_debug_env  → FAIL: $($_.Exception.Message)" -ForegroundColor Red
}
