Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    Write-Host "PID=$($_.OwningProcess) Port=$($_.LocalPort) Cmd=$($proc.CommandLine)"
}
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    Write-Host "PID=$($_.OwningProcess) Port=$($_.LocalPort) Cmd=$($proc.CommandLine)"
}
