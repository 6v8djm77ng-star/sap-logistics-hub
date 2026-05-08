# Test access to AVIAD-WIN10 from this computer
$target = 'AVIAD-WIN10'

Write-Host "=== Test 1: Ping ===" -ForegroundColor Cyan
Test-Connection -ComputerName $target -Count 1 -Quiet -ErrorAction SilentlyContinue

Write-Host "`n=== Test 2: SMB port 445 ===" -ForegroundColor Cyan
$tcp = Test-NetConnection -ComputerName $target -Port 445 -WarningAction SilentlyContinue
"  Reachable: $($tcp.TcpTestSucceeded)"

Write-Host "`n=== Test 3: C$ admin share ===" -ForegroundColor Cyan
try {
    $folders = Get-ChildItem "\\$target\C`$\Users" -ErrorAction Stop | Select-Object -First 10 Name
    Write-Host "  Access OK. User folders:" -ForegroundColor Green
    $folders | ForEach-Object { "    - $($_.Name)" }
} catch {
    Write-Host "  Cannot access C`$: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n=== Test 4: User-specific shares ===" -ForegroundColor Cyan
try {
    $shares = Get-CimInstance -ClassName Win32_Share -ComputerName $target -ErrorAction Stop
    Write-Host "  Visible shares:" -ForegroundColor Green
    $shares | Select-Object Name, Path, Description | Format-Table -AutoSize
} catch {
    Write-Host "  Cannot enumerate shares: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n=== Test 5: WinRM port 5985 ===" -ForegroundColor Cyan
$winrm = Test-NetConnection -ComputerName $target -Port 5985 -WarningAction SilentlyContinue
"  Reachable: $($winrm.TcpTestSucceeded)"

Write-Host "`n=== Test 6: Public Desktop write ===" -ForegroundColor Cyan
$publicDesktop = "\\$target\C`$\Users\Public\Desktop"
try {
    $testFile = Join-Path $publicDesktop "test-write-$(Get-Random).txt"
    "test" | Out-File -FilePath $testFile -ErrorAction Stop
    Remove-Item $testFile -ErrorAction SilentlyContinue
    Write-Host "  Public Desktop is WRITABLE" -ForegroundColor Green
} catch {
    Write-Host "  Cannot write to Public Desktop: $($_.Exception.Message)" -ForegroundColor Yellow
}
