@echo off
title Sabir Juice Corner - ERP/POS
color 0A

echo.
echo  ============================================
echo   Sabir Juice Corner -- ERP/POS Launcher
echo  ============================================
echo.

:: Step 1: Make sure Docker Desktop is running
echo [1/4] Checking Docker...
docker ps >nul 2>&1
if %errorlevel% neq 0 (
    echo     Docker not running. Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo     Waiting for Docker to be ready. Please wait...
    :wait_docker
    timeout /t 3 /nobreak >nul
    docker ps >nul 2>&1
    if %errorlevel% neq 0 goto wait_docker
    echo     Docker is ready.
) else (
    echo     Docker is already running.
)

:: Step 2: Start PostgreSQL container
echo [2/4] Starting database...
docker start sjc-postgres >nul 2>&1
if %errorlevel% neq 0 (
    echo     Container not found -- creating via docker compose...
    docker compose -f "%~dp0docker-compose.yml" up -d postgres >nul 2>&1
)
echo     Database started.

:: Step 3: Start API server
echo [3/4] Starting API server on port 4000...
start "SJC API" cmd /k "cd /d "%~dp0" && pnpm --filter @sjc/api dev"
timeout /t 5 /nobreak >nul

:: Step 4: Start frontend apps
echo [4/4] Starting POS (port 3000) and Admin (port 3100)...
start "SJC POS" cmd /k "cd /d "%~dp0" && pnpm --filter @sjc/pos dev"
start "SJC Admin" cmd /k "cd /d "%~dp0" && pnpm --filter @sjc/admin dev"

echo     Waiting for servers to come up...
timeout /t 10 /nobreak >nul

:: Open POS with --kiosk-printing so Print Bill fires immediately with no dialog.
:: The actual browser-launch logic lives in open-pos.bat (also used to reopen
:: just the POS window later without restarting the servers) so the two never
:: drift out of sync. Chrome is preferred over Edge there — Edge caches its
:: own "last used printer" internally and doesn't reliably re-sync when the
:: Windows default printer changes, which silently broke kiosk-printing here
:: even after the OS default was corrected; Chrome had no such stale cache.
call "%~dp0open-pos.bat"

:: Admin opens in a normal browser window (no silent print needed there)
start "" http://localhost:3100

echo.
echo  ============================================
echo   All services started!
echo     API   -^> http://localhost:4000
echo     POS   -^> http://localhost:3000
echo     Admin -^> http://localhost:3100
echo  ============================================
echo.
