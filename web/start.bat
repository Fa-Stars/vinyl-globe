@echo off
chcp 65001 >nul
rem 世界唱片机启动脚本 —— 双击即可启动
cd /d "%~dp0"
echo 正在启动 世界唱片机 ...
echo 启动完成后请用浏览器打开 http://localhost:3000
echo 关闭本窗口即停止服务。
echo.
cd /d "%~dp0.."
node web\server.js
pause
