<#
  stop_all.ps1 — 一键停止整套开发环境
  - Next.js dev (port 3000)
  - VoxCPM watchdog + server.py (port 8000)
  - 不会影响其他无关进程
#>

$ErrorActionPreference = 'SilentlyContinue'
$Root    = 'D:\AItrade\openmaic'
$RepoDir = Join-Path $Root 'OpenMAIC'
$VoxDir  = Join-Path $Root 'VoxCPM'

function Write-Step($msg) { Write-Host "[stop_all] $msg" -ForegroundColor Cyan }
function Write-Ok  ($msg) { Write-Host "[stop_all] $msg" -ForegroundColor Green }

# 1) 杀 watchdog (它会自动停 server.py)
Write-Step "停止 VoxCPM watchdog..."
$wdPids = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*watchdog.ps1*' -and $_.CommandLine -like '*VoxCPM*' } |
    Select-Object -ExpandProperty ProcessId
foreach ($p in $wdPids) {
  Write-Ok "杀 watchdog PID=$p"
  Stop-Process -Id $p -Force
}

# 2) 杀 server.py (watchdog 关后, server.py 还活着)
Write-Step "停止 server.py..."
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*VoxCPM*server.py*' } |
    ForEach-Object {
      Write-Ok "杀 server.py PID=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force
    }

# 3) 杀 Next.js dev
Write-Step "停止 Next.js dev (port 3000)..."
$p3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p3000) {
  Write-Ok "杀 dev PID=$($p3000.OwningProcess)"
  Stop-Process -Id $p3000.OwningProcess -Force
}

# 4) 兜底 — 如果 3000 还在 listen, 再杀
Start-Sleep -Seconds 3
$still3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$still8000 = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($still3000) { Write-Host "[stop_all] WARN port 3000 仍在 — PID=$($still3000.OwningProcess)" }
if ($still8000) { Write-Host "[stop_all] WARN port 8000 仍在 — PID=$($still8000.OwningProcess)" }
if (-not $still3000 -and -not $still8000) { Write-Ok "两个端口都释放了" }
