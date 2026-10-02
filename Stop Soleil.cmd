@echo off
powershell.exe -NoProfile -File "%~dp0scripts\stop-local.ps1"
if errorlevel 1 pause
