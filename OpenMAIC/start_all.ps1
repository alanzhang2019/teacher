<#
  start_all.ps1 — 一键启动整套开发环境
  - OpenMAIC dev server  (port 3000)
  - VoxCPM TTS 后端     (port 8000, via watchdog)
  - 两个都跟 Trae 解耦: 关闭 PowerShell / Trae / IDE 都不会杀掉它们

  用法:
    powershell -NoProfile -ExecutionPolicy Bypass -File D:\AItrade\openmaic\OpenMAIC\start_all.ps1
  配套:
    stop_all.ps1   一键停所有
    status_all.ps1 查状态
#>

$ErrorActionPreference = 'Continue'
$Root       = 'D:\AItrade\openmaic'
$RepoDir    = Join-Path $Root 'OpenMAIC'
$VoxDir     = Join-Path $Root 'VoxCPM'
$LogDir     = $RepoDir  # 日志统一放在 repo 根

function Write-Step($msg) { Write-Host "[start_all] $msg" -ForegroundColor Cyan }
function Write-Ok  ($msg) { Write-Host "[start_all] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[start_all] $msg" -ForegroundColor Yellow }

# ----------------------------------------------------------------------------
# 0) 确保只启动一份 — 如果已运行则提示并退出
# ----------------------------------------------------------------------------
$port3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$port8000 = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
$watchdogPids = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*watchdog.ps1*' -and $_.CommandLine -like '*VoxCPM*' } |
    Select-Object -ExpandProperty ProcessId

if ($port3000 -or $port8000 -or $watchdogPids) {
  Write-Warn "已有实例在跑:"
  if ($port3000) { Write-Warn "  - port 3000 PID=$($port3000.OwningProcess)" }
  if ($port8000) { Write-Warn "  - port 8000 PID=$($port8000.OwningProcess)" }
  if ($watchdogPids) { Write-Warn "  - watchdog.ps1 PIDs: $($watchdogPids -join ', ')" }
  Write-Warn "如需重启请先跑 stop_all.ps1"
  exit 0
}

# ----------------------------------------------------------------------------
# 1) 启动 VoxCPM watchdog (在后台, 隐藏窗口, 完全脱离 Trae)
# ----------------------------------------------------------------------------
Write-Step "启动 VoxCPM watchdog..."
$watchdogScript = Join-Path $VoxDir 'watchdog.ps1'
if (-not (Test-Path $watchdogScript)) {
  Write-Warn "watchdog.ps1 不存在: $watchdogScript"
  Write-Warn "跳过 VoxCPM — dev server 仍会启动但 TTS 会 500"
}
else {
  $wd = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchdogScript) `
        -WorkingDirectory $VoxDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'watchdog.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'watchdog.err.log') `
        -PassThru
  Write-Ok "watchdog 启动 PID=$($wd.Id), 日志: watchdog.out.log"
}

# ----------------------------------------------------------------------------
# 2) 启动 Next.js dev (在后台, 隐藏窗口, 完全脱离 Trae)
# ----------------------------------------------------------------------------
Write-Step "启动 OpenMAIC dev (Next.js webpack)..."
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) {
  Write-Warn "找不到 pnpm.cmd — 请先 'npm i -g pnpm'"
  exit 1
}
$dev = Start-Process -FilePath $pnpm `
       -ArgumentList 'dev' `
       -WorkingDirectory $RepoDir `
       -WindowStyle Hidden `
       -RedirectStandardOutput (Join-Path $LogDir 'dev.out.log') `
       -RedirectStandardError  (Join-Path $LogDir 'dev.err.log') `
       -PassThru
Write-Ok "dev 启动 PID=$($dev.Id), 日志: dev.out.log"

# ----------------------------------------------------------------------------
# 3) 探活 — 等到两个端口都 listening 才算成功
# ----------------------------------------------------------------------------
Write-Step "等待服务就绪 (最多 90s)..."
$deadline = (Get-Date).AddSeconds(90)
$ok3000 = $false
$ok8000 = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (-not $ok3000) {
    $p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($p) { $ok3000 = $true; Write-Ok "port 3000 listening (PID=$($p.OwningProcess))" }
  }
  if (-not $ok8000) {
    $p = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
    if ($p) { $ok8000 = $true; Write-Ok "port 8000 listening (PID=$($p.OwningProcess))" }
  }
  if ($ok3000 -and $ok8000) { break }
}

if (-not $ok3000) { Write-Warn "port 3000 90s 内没起来 — 看 dev.out.log" }
if (-not $ok8000) { Write-Warn "port 8000 90s 内没起来 — 看 watchdog.out.log / VoxCPM\server.log" }

# ----------------------------------------------------------------------------
# 4) 打浏览器
# ----------------------------------------------------------------------------
if ($ok3000) {
  Write-Ok "打开浏览器 -> http://localhost:3000"
  Start-Process 'http://localhost:3000'
}

Write-Host ""
Write-Host "[============================================]" -ForegroundColor Green
Write-Ok "start_all 完成"
Write-Host "  状态查询: powershell -File $RepoDir\status_all.ps1" -ForegroundColor Green
Write-Host "  停止全部: powershell -File $RepoDir\stop_all.ps1" -ForegroundColor Green
Write-Host "  dev 日志: Get-Content $RepoDir\dev.out.log -Wait" -ForegroundColor Green
Write-Host "  vox 日志: Get-Content $RepoDir\watchdog.out.log -Wait" -ForegroundColor Green
Write-Host "[============================================]" -ForegroundColor Green
