@echo off
title Sabir Juice Corner - ERP/POS

echo Starting Sabir Juice Corner...

:: Start API
start "SJC - API" cmd /k "cd /d "%~dp0" && pnpm --filter @sjc/api dev"

:: Wait a moment for API to initialize before starting frontends
timeout /t 3 /nobreak >nul

:: Start POS
start "SJC - POS" cmd /k "cd /d "%~dp0" && pnpm --filter @sjc/pos dev"

:: Start Admin
start "SJC - Admin" cmd /k "cd /d "%~dp0" && pnpm --filter @sjc/admin dev"

:: Wait for servers to be ready then open browser
timeout /t 6 /nobreak >nul

:: Open POS with --kiosk-printing so Print Bill fires immediately with no dialog
:: (prints silently to whatever printer is set as Windows default)
set BROWSER="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if exist %BROWSER% (
    start "" %BROWSER% --app=http://localhost:3000 --kiosk-printing
) else (
    start "" http://localhost:3000
)

:: Admin opens in a normal browser window (no silent print needed there)
start "" http://localhost:3100

echo.
echo All services started!
echo   API    -> http://localhost:4000
echo   POS    -> http://localhost:3000  (Chrome silent-print mode)
echo   Admin  -> http://localhost:3100
