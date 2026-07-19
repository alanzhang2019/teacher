$ErrorActionPreference = 'Continue'
Set-Location 'D:\AItrade\openmaic\OpenMAIC'
$proc = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'dev' -RedirectStandardOutput 'D:\AItrade\openmaic\OpenMAIC\dev.out.log' -RedirectStandardError 'D:\AItrade\openmaic\OpenMAIC\dev.err.log' -PassThru -NoNewWindow
Write-Host "Started PID=$($proc.Id)"
