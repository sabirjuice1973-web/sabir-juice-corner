@echo off
title Sabir Juice Corner - Reopen POS

:: Use this when the POS window was closed but the servers (API/POS/Admin)
:: are still running from start.bat — it just reopens the browser window,
:: it does not start the servers again.

set BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
set POS_PROFILE_DIR=%~dp0.pos-chrome-profile

if exist %BROWSER% (
    start "" %BROWSER% --user-data-dir="%POS_PROFILE_DIR%" --app=http://localhost:3000 --kiosk-printing
) else (
    start "" http://localhost:3000
)
