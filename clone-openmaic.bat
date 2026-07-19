@echo off
setlocal
cd /d d:\AItrade\openmaic
echo === [1/4] 配置 git 参数 ===
git config --global http.postBuffer 524288000
git config --global core.compression 0
if exist OpenMAIC rmdir /s /q OpenMAIC

echo === [2/4] 浅克隆 (main) ===
git clone --depth 1 --branch main https://github.com/THU-MAIC/OpenMAIC.git OpenMAIC
if errorlevel 1 (
    echo === 主站失败, 尝试镜像 ===
    git clone --depth 1 --branch main https://ghfast.top/https://github.com/THU-MAIC/OpenMAIC.git OpenMAIC
)
if errorlevel 1 (
    echo === 尝试 zip 下载 ===
    powershell -Command "Invoke-WebRequest -Uri 'https://codeload.github.com/THU-MAIC/OpenMAIC/zip/refs/heads/main' -OutFile 'd:\AItrade\openmaic\OpenMAIC.zip'; Expand-Archive -Path 'd:\AItrade\openmaic\OpenMAIC.zip' -DestinationPath 'd:\AItrade\openmaic\' -Force"
    if exist OpenMAIC-main ren OpenMAIC-main OpenMAIC
    if exist OpenMAIC.zip del OpenMAIC.zip
)
if exist OpenMAIC\.git (
    echo === 克隆成功 ===
    dir OpenMAIC
) else (
    echo === 失败,请检查网络 ===
)
pause
