# Start Zukunft in development mode.
# Tauri's beforeDevCommand starts the Next.js dev server (port 3000) on its own,
# so this window runs the desktop app; no separate backend process is needed.
#
#   .\dev.ps1          Desktop app against the real GitHub API
#   .\dev.ps1 -Mock    Browser only, mock data, no GitHub connection
#   .\dev.ps1 -Web     Read-only web view (port 3001)

param(
    [switch]$Mock,
    [switch]$Web
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# Install workspace dependencies on first run
if (-not (Test-Path "$root\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    Push-Location $root
    yarn install
    Pop-Location
}

Set-Location $root

if ($Mock) {
    # No GitHub credentials involved. Append ?failure=1 or ?conflict=1 to the URL
    # to exercise the retry / conflict paths.
    Write-Host "Mock mode: http://localhost:3000" -ForegroundColor Cyan
    yarn dev:desktop
    return
}

if ($Web) {
    if (-not $env:ZUKUNFT_GITHUB_READ_TOKEN) {
        Write-Host "ZUKUNFT_GITHUB_READ_TOKEN is not set - the web view cannot read GitHub." -ForegroundColor Yellow
    }
    if (-not $env:ZUKUNFT_PUBLIC_PROJECT_IDS) {
        Write-Host "ZUKUNFT_PUBLIC_PROJECT_IDS is not set - every project will return 404." -ForegroundColor Yellow
    }
    Write-Host "Read-only web: http://localhost:3001" -ForegroundColor Cyan
    yarn dev:web
    return
}

# setx only affects processes started afterwards, so a window opened before the
# variable was set will not see it. Say so instead of letting the app silently
# fall back to the sign-in screen.
if (-not $env:ZUKUNFT_GITHUB_TOKEN) {
    Write-Host "ZUKUNFT_GITHUB_TOKEN is not visible in this session." -ForegroundColor Yellow
    Write-Host "Open a new terminal, or sign in from inside the app." -ForegroundColor Yellow
} else {
    Write-Host "Using GitHub token from the environment." -ForegroundColor Cyan
}

yarn tauri:dev
