# הפעלה מהירה לפיתוח - מריץ backend + frontend במקביל
# Run as: ./start-dev.ps1

Write-Host "🚚 SAP Logistics Hub - Development Startup" -ForegroundColor Cyan
Write-Host ""

# Check Node
$nodeVer = node --version 2>$null
if (-not $nodeVer) {
    Write-Host "❌ Node.js not found. Please install from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Node $nodeVer" -ForegroundColor Green

# Check .env
if (-not (Test-Path "backend/.env")) {
    Write-Host "⚠  backend/.env not found - copying from .env.example" -ForegroundColor Yellow
    Copy-Item backend/.env.example backend/.env
    Write-Host "   Please edit backend/.env with your SAP credentials, then run this again." -ForegroundColor Yellow
    exit 0
}

# Install deps if needed
if (-not (Test-Path "backend/node_modules")) {
    Write-Host "→ Installing backend dependencies..." -ForegroundColor Cyan
    Push-Location backend
    npm install
    Pop-Location
}
if (-not (Test-Path "frontend/node_modules")) {
    Write-Host "→ Installing frontend dependencies..." -ForegroundColor Cyan
    Push-Location frontend
    npm install
    Pop-Location
}

# Start backend + frontend in separate windows
Write-Host ""
Write-Host "🔵 Starting backend on http://localhost:4000" -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd backend; npm run dev"

Start-Sleep -Seconds 2

Write-Host "🟢 Starting frontend on http://localhost:5173" -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd frontend; npm run dev"

Write-Host ""
Write-Host "✓ Both servers starting in new windows." -ForegroundColor Green
Write-Host "  Planner UI:    http://localhost:5173" -ForegroundColor White
Write-Host "  Driver PWA:    http://localhost:5173/driver" -ForegroundColor White
Write-Host "  API:           http://localhost:4000" -ForegroundColor White
