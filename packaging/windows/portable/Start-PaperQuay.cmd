@echo off
setlocal
rem Grant Chromium's sandbox package SID read/execute access before starting.
rem Only the dedicated app payload may receive this ACE. Never grant on the extraction parent.
set "APP_DIR=%~dp0PaperQuay-app"
if not exist "%APP_DIR%\PaperQuay.exe" (
  echo PaperQuay-app\PaperQuay.exe is missing. Extract the entire portable ZIP first.
  exit /b 1
)
"%SystemRoot%\System32\icacls.exe" "%APP_DIR%" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T >nul
if errorlevel 1 (
  echo Failed to prepare the PaperQuay portable sandbox directory.
  echo Extract the ZIP to a directory you can modify, then run this launcher again.
  exit /b 1
)
start "" "%APP_DIR%\PaperQuay.exe" %*
