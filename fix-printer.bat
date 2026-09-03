@echo off
title Sabir Juice Corner - Fix Printer (one-time)

:: Use this ONCE after swapping the receipt printer (new printer, or driver
:: reinstalled). Normal POS printing uses --kiosk-printing, which prints
:: silently with NO dialog and NO error message if anything is wrong — it
:: just remembers whatever printer + paper size you last picked, inside
:: this same Chrome profile (.pos-chrome-profile). When the printer changes,
:: that memory is stale and silent printing quietly does nothing.
::
:: This script opens the SAME profile WITHOUT --kiosk-printing, so the print
:: dialog actually shows up. Steps:
::   1. This opens the POS app in a normal (non-silent) window.
::   2. Log in if asked, open any order, click Print Bill (or Print Bill + Save).
::   3. The Windows print dialog appears — pick "BIXOLON SRP-QE302" as the
::      printer, make sure Paper Size is the 80mm/3-inch roll size (not a
::      default like Letter/A4), then click Print.
::   4. Close this window. From now on, double-click open-pos.bat as usual —
::      silent printing will use the printer + paper size you just picked.

set BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
set POS_PROFILE_DIR=%~dp0.pos-chrome-profile

echo.
echo Opening POS WITHOUT silent printing so you can pick the new printer once.
echo Print any bill, choose BIXOLON SRP-QE302 + 80mm paper size in the dialog,
echo then close this window and go back to using open-pos.bat as normal.
echo.

if exist %BROWSER% (
    start "" %BROWSER% --user-data-dir="%POS_PROFILE_DIR%" --app=http://localhost:3000
) else (
    start "" http://localhost:3000
)
