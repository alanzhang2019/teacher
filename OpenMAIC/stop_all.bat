@echo off
REM 一键停止 OpenMAIC + VoxCPM 开发环境
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_all.ps1"
pause
