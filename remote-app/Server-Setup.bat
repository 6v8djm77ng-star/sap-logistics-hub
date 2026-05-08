@echo off
chcp 65001 > nul
title SAP Logistics Hub - Server Setup (Run on the HOST computer)

echo.
echo ==================================================
echo   SAP Logistics Hub - Server Setup
echo   (Run this ONCE on the HOST computer - 192.168.0.14)
echo ==================================================
echo.
echo This will:
echo   1. Open Windows Firewall port 4000 for the LAN.
echo   2. Show the URLs that other computers should use.
echo.
echo This requires Administrator privileges.
echo.
pause

powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -NoProfile -File \"%~dp0..\open-firewall.ps1\"'"

echo.
echo If a UAC prompt appeared - click YES.
echo The firewall has been opened for port 4000 on this computer.
echo.
echo Other computers on the network can now reach:
echo    http://192.168.0.14:4000
echo.
pause
