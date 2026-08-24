@echo off
chcp 65001 >nul
rem 世界唱片机启动脚本 —— 双击即可启动
cd /d "%~dp0"
echo 正在启动 世界唱片机 ...
echo 启动完成后请用浏览器打开 http://localhost:3000
echo 按 Ctrl+C 或直接关闭本窗口，退出时都会尝试清理运行缓存。
echo.
cd /d "%~dp0.."
set "WORLD_VINYL_CLEAR_CACHE_ON_EXIT=1"
set "WORLD_VINYL_BROWSER_LIFECYCLE=1"
node web\server.js
pause
