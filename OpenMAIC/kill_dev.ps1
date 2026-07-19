Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Killing PID=$($_.OwningProcess)"
    Stop-Process -Id $_.OwningProcess -Force
}
Start-Sleep -Seconds 3
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "Still listening PID=$($_.OwningProcess)" }
Write-Host "Done"
