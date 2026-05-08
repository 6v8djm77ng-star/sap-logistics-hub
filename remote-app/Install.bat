@echo off
chcp 65001 > nul
title SAP Logistics Hub - LAN Installer

echo.
echo ==================================================
echo   SAP Logistics Hub - LAN Client Installer
echo ==================================================
echo.
echo This will create 3 shortcuts on your Desktop:
echo   - SAP Logistics Hub
echo   - SAP Logistics - Driver
echo   - SAP Logistics - Admin
echo.
echo Server: http://192.168.0.14:4000
echo.
echo Press any key to continue, or close this window to cancel.
pause > nul

powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0Install.ps1"

if %errorlevel% neq 0 (
    echo.
    echo Installation failed. Press any key to close...
    pause > nul
)
