@echo off
powershell.exe -NoProfile -File "%~dp0scripts\start-local.ps1" -OpenBrowser
if errorlevel 1 pause
