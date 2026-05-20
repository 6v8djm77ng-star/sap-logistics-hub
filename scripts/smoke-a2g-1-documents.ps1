# Smoke test for Phase A2g-1 — Documents route parity on hardened server.
#
# Run AFTER `pm2 reload sap-logistics`. Without that reload PM2 still
# serves the pre-A2g build and all three endpoints return 404.
#
# What this script verifies:
#   1. /api/documents/stats     responds (401 without token, NOT 404)
#   2. /api/delivery-notes      responds (401 without token, NOT 404)
#   3. /api/invoices            responds (401 without token, NOT 404)
#
# Authenticated smoke (run manually with a real admin/planner token):
#   $T = '<paste token>'
#   curl -H "Authorization: Bearer $T" http://localhost:4000/api/documents/stats
#     → 200 with { deliveryNotes:{...}, invoices:{...}, audit:{...} }
#   curl -H "Authorization: Bearer $T" http://localhost:4000/api/delivery-notes
#     → 200 with { deliveryNotes: [...] }
#   curl -H "Authorization: Bearer $T" http://localhost:4000/api/invoices
#     → 200 with { invoices: [...] }
#
# Exit codes:
#   0 = all three endpoints registered and auth-gated (401)
#   2 = at least one endpoint missing (404) or unreachable
#
# This script does NOT mutate state, does not call SAP, does not require .env changes.

$ErrorActionPreference = 'Continue'
$base = 'http://localhost:4000'
$endpoints = @(
    '/api/documents/stats',
    '/api/delivery-notes',
    '/api/invoices'
)

Write-Output "=== A2g-1 smoke: no-token probe (expect 401, NOT 404) ==="
$failed = 0
foreach ($path in $endpoints) {
    try {
        $r = Invoke-WebRequest -Uri "$base$path" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Output "$path  →  $($r.StatusCode)  (unexpected: should require auth)"
        $failed++
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
        if ($code -eq 401) {
            Write-Output "$path  →  401  ✅ registered + auth-gated"
        } elseif ($code -eq 404) {
            Write-Output "$path  →  404  ❌ NOT REGISTERED — did you forget to pm2 reload sap-logistics?"
            $failed++
        } else {
            Write-Output "$path  →  $code  ⚠ unexpected"
            $failed++
        }
    }
}

if ($failed -eq 0) {
    Write-Output ""
    Write-Output "All three endpoints registered. Proceed with authenticated smoke."
    exit 0
} else {
    Write-Output ""
    Write-Output "$failed endpoint(s) failed. Check pm2 logs and confirm sap-logistics is running the A2g-1 build."
    exit 2
}
