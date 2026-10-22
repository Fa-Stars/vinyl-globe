@echo off
rem Start a World Vinyl server the iPhone can reach.
rem   default node web/server.js listens on 127.0.0.1 only, so the phone cannot connect.
rem   This script listens on all interfaces and prints the LAN addresses to type into the app.
setlocal

cd /d "%~dp0.."

if not defined PORT set PORT=3000
set WORLD_VINYL_HOST=0.0.0.0
rem Web mode exits when the last page closes; a phone going to background counts as
rem closing a page, so keep the server alive until Ctrl+C.
set WORLD_VINYL_BROWSER_LIFECYCLE=0

echo.
echo   World Vinyl - LAN server
echo   listening on 0.0.0.0:%PORT%
echo.
echo   Type one of these into the iPhone app settings (no http://):
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo     %%b:%PORT%
)
echo.
echo   If Windows Firewall asks, allow access for the Private network.
echo   Press Ctrl+C to stop.
echo.

node web/server.js
