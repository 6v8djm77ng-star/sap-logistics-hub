# פותח את ה-Firewall לגישה ברשת המקומית
# הרץ קליק ימני → "הפעל בעזרת PowerShell" (כמנהל)

Write-Host "פותח את ה-Firewall לפורט 4000..." -ForegroundColor Cyan

# Remove old rule if exists
netsh advfirewall firewall delete rule name="SAP Logistics Hub Demo" 2>$null | Out-Null

# Add new rule
$result = netsh advfirewall firewall add rule `
    name="SAP Logistics Hub Demo" `
    dir=in action=allow `
    protocol=TCP localport=4000 `
    profile=private,domain,public

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✓ הצלחה! הפורט פתוח." -ForegroundColor Green
    Write-Host "`nעכשיו כל מחשב ברשת יכול להתחבר לכתובת:" -ForegroundColor White

    $ips = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' }

    foreach ($ip in $ips) {
        Write-Host "  → http://$($ip.IPAddress):4000" -ForegroundColor Yellow
    }

    Write-Host "`nלחץ Enter לסגירה..."
    Read-Host
} else {
    Write-Host "`n✗ שגיאה. וודא שהרצת כמנהל (קליק ימני → 'הפעל בעזרת PowerShell')" -ForegroundColor Red
    Read-Host
}
