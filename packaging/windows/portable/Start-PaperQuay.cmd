@echo off
setlocal
rem Grant Chromium's sandbox package SID read/execute access before starting.
rem The inherited ACE is limited to this extracted portable directory.
"%SystemRoot%\System32\icacls.exe" "%~dp0." /grant "*S-1-15-2-2:(OI)(CI)(RX)" >nul
if errorlevel 1 (
  echo Failed to prepare the PaperQuay portable sandbox directory.
  echo Extract the ZIP to a directory you can modify, then run this launcher again.
  exit /b 1
)
start "" "%~dp0PaperQuay.exe" %*
