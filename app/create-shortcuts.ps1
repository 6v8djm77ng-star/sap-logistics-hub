# Creates desktop shortcuts - English-only to avoid encoding issues
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$wshell = New-Object -ComObject WScript.Shell

# Start
$s1 = $wshell.CreateShortcut("$desktop\SAP Logistics Hub.lnk")
$s1.TargetPath = 'powershell.exe'
$s1.Arguments = "-ExecutionPolicy Bypass -NoProfile -File `"$appDir\start-app.ps1`""
$s1.WorkingDirectory = $appDir
$s1.WindowStyle = 1
$s1.Description = 'Start SAP Logistics Hub'
$s1.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,239"
$s1.Save()
Write-Host 'Created: SAP Logistics Hub' -ForegroundColor Green

# Stop
$s2 = $wshell.CreateShortcut("$desktop\Stop SAP Logistics Hub.lnk")
$s2.TargetPath = 'powershell.exe'
$s2.Arguments = "-ExecutionPolicy Bypass -NoProfile -File `"$appDir\stop-app.ps1`""
$s2.WorkingDirectory = $appDir
$s2.WindowStyle = 1
$s2.Description = 'Stop SAP Logistics Hub'
$s2.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,131"
$s2.Save()
Write-Host 'Created: Stop SAP Logistics Hub' -ForegroundColor Green

# Update
$s3 = $wshell.CreateShortcut("$desktop\Update SAP Logistics Hub.lnk")
$s3.TargetPath = 'powershell.exe'
$s3.Arguments = "-ExecutionPolicy Bypass -NoProfile -File `"$appDir\update-app.ps1`""
$s3.WorkingDirectory = $appDir
$s3.WindowStyle = 1
$s3.Description = 'Update to latest version'
$s3.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,238"
$s3.Save()
Write-Host 'Created: Update SAP Logistics Hub' -ForegroundColor Green

Write-Host ''
Write-Host 'Done! 3 shortcuts created on Desktop.' -ForegroundColor Cyan
