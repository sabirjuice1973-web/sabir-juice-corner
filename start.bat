@echo off
title Sabir Juice Corner - ERP/POS
color 0A
set "PROJ=C:\Users\HTC\sabir-juice-corner"

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
    docker compose -f "%PROJ%\docker-compose.yml" up -d postgres >nul 2>&1
)
echo     Database started.

:: Step 3: Start API server
echo [3/4] Starting API server on port 4000...
start "SJC API" cmd /k "cd /d %PROJ% && pnpm --filter @sjc/api dev"
timeout /t 5 /nobreak >nul

:: Step 4: Start frontend apps
echo [4/4] Starting POS (port 3000) and Admin (port 3100)...
start "SJC POS" cmd /k "cd /d %PROJ% && pnpm --filter @sjc/pos dev"
start "SJC Admin" cmd /k "cd /d %PROJ% && pnpm --filter @sjc/admin dev"

echo     Waiting for servers to come up...
timeout /t 10 /nobreak >nul

:: Open browser windows
set EDGE="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
set EDGE_X86="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set CHROME_X86="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if exist %EDGE% (
    start "" %EDGE% --app=http://localhost:3000 --kiosk-printing
    start "" %EDGE% http://localhost:3100
) else if exist %EDGE_X86% (
    start "" %EDGE_X86% --app=http://localhost:3000 --kiosk-printing
    start "" %EDGE_X86% http://localhost:3100
) else if exist %CHROME% (
    start "" %CHROME% --app=http://localhost:3000 --kiosk-printing
    start "" %CHROME% http://localhost:3100
) else (
    start "" http://localhost:3000
    start "" http://localhost:3100
)

echo.
echo  ============================================
echo   All services started!
echo     API   -^> http://localhost:4000
echo     POS   -^> http://localhost:3000
echo     Admin -^> http://localhost:3100
echo  ============================================
echo.
