#Requires -Version 5.1
# OpenMAIC 一键克隆脚本
$ErrorActionPreference = 'Stop'
$target = 'd:\AItrade\openmaic\OpenMAIC'

Write-Host "[1/4] 调整 git 参数（加大缓冲、放宽超时）..." -ForegroundColor Cyan
git config --global http.postBuffer 524288000
git config --global http.lowSpeedLimit 0
git config --global http.lowSpeedTime 999999
git config --global core.compression 0

if (Test-Path $target) {
    Write-Host "[2/4] 清理残留目录 $target ..." -ForegroundColor Yellow
    Remove-Item $target -Recurse -Force
}

Set-Location 'd:\AItrade\openmaic'
Write-Host "[3/4] 浅克隆 THU-MAIC/OpenMAIC (main 分支)..." -ForegroundColor Cyan
try {
    git clone --depth 1 --branch main https://github.com/THU-MAIC/OpenMAIC.git OpenMAIC
    if ($LASTEXITCODE -ne 0) { throw "exit=$LASTEXITCODE" }
} catch {
    Write-Host "[3/4] 主站失败，尝试镜像 ghfast.top ..." -ForegroundColor Yellow
    git clone --depth 1 --branch main https://ghfast.top/https://github.com/THU-MAIC/OpenMAIC.git OpenMAIC
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[3/4] 镜像也失败，下载 zip 压缩包..." -ForegroundColor Yellow
        $zip = 'd:\AItrade\openmaic\OpenMAIC.zip'
        Invoke-WebRequest -Uri 'https://codeload.github.com/THU-MAIC/OpenMAIC/zip/refs/heads/main' -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath 'd:\AItrade\openmaic\' -Force
        if (Test-Path 'd:\AItrade\openmaic\OpenMAIC-main') {
            Rename-Item 'd:\AItrade\openmaic\OpenMAIC-main' 'OpenMAIC'
        }
        Remove-Item $zip -Force
    }
}

Write-Host "[4/4] 验证..." -ForegroundColor Cyan
if (Test-Path "$target\.git") {
    Write-Host "OK  克隆成功：$target" -ForegroundColor Green
    Get-ChildItem $target | Select-Object Name | Format-Table -AutoSize
} else {
    Write-Host "FAIL  请检查网络或手动重试" -ForegroundColor Red
}
Read-Host "按回车退出"
