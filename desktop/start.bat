@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 世界唱片机 Electron 桌面程序 ...
cd /d "%~dp0.."
npm start
pause
