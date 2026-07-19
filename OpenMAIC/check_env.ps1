try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/_debug_env' -UseBasicParsing -TimeoutSec 30
    Write-Host $r.Content
} catch {
    Write-Host "ERR: $($_.Exception.Message)"
}
