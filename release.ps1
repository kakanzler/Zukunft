# Cut a Zukunft release: bump the version, verify, commit, tag, build the
# installer and install it. Every step runs unattended - nothing here waits on a
# dialog - so an agent can drive the whole release without a human at the screen.
#
#   ./release.ps1 0.1.2                    bump, verify, commit, tag. No push, no build.
#   ./release.ps1 0.1.2 -Push              ... and push main + the tag to origin.
#   ./release.ps1 0.1.2 -Push -Install     the full release: ... build the installers,
#                                          install silently, and verify what landed.
#   ./release.ps1 -Install                 rebuild and reinstall the CURRENT version.
#                                          No git work at all - for "the app does not
#                                          show my change" after editing code or icons.
#   ./release.ps1 0.1.2 -DryRun            print what would change and stop.
#
# WHY THE STALE-BINARY GUARD EXISTS. Editing a file changes nothing about the
# installed app until the Rust binary is relinked AND the installer is re-run.
# It bit us on 2026-08-31: the app icon was regenerated and committed, `cargo
# check` passed, the release was tagged and pushed - and the app on screen still
# showed the old icon, because the last actual build predated the new icon by a
# day. -Install therefore refuses to install a zukunft.exe that is older than
# anything baked into it (Rust sources, the icons, tauri.conf.json, the Next UI,
# the workspace packages). -Force overrides the refusal.
#
# The install is per-user (Tauri's NSIS default, registered under HKCU), so no
# elevation and no UAC prompt. Your GitHub token is untouched: it lives in the
# Windows credential store, not in the install folder.

param(
    # Omit to skip all git and version work and only build/install.
    [Parameter(Position = 0)][string]$Version,
    [switch]$Push,
    # Build the MSI and NSIS bundles. Implied by -Install.
    [switch]$Installer,
    # ... and run the NSIS installer silently, then verify what was installed.
    [switch]$Install,
    [switch]$DryRun,
    # Overrides the stale-binary refusal. Only when you know the build is current.
    [switch]$Force,
    # Passed to NSIS as /D so the location is deterministic. NSIS falls back to
    # its own default once the uninstall registry entry is gone - which is exactly
    # what the previous version's uninstaller removes during an upgrade.
    [string]$InstallDir = "D:\Program Files\Zukunft"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Fail($message) { Write-Host $message -ForegroundColor Red; exit 1 }

$bumping = -not [string]::IsNullOrWhiteSpace($Version)
$building = $Installer -or $Install
if (-not $bumping -and -not $building) {
    Fail "Nothing to do. Give a version to release, or -Install to rebuild and reinstall the current one."
}

$exePath = "$root\apps\desktop\src-tauri\target\release\zukunft.exe"

# The version in tauri.conf.json is what the installer and the registry report.
function Get-ConfiguredVersion {
    (Select-String -Path "$root\apps\desktop\src-tauri\tauri.conf.json" -Pattern '"version":\s*"([^"]+)"').Matches[0].Groups[1].Value
}

# ---------------------------------------------------------------- version bump

if ($bumping) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Fail "Version must look like 1.2.3 (got '$Version')."
    }

    $tag = "v$Version"

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne "main") { Fail "On branch '$branch'. Releases are cut from main." }
    if (git tag --list $tag) { Fail "Tag $tag already exists." }

    $dirty = git status --porcelain
    if ($dirty -and -not $DryRun) {
        Write-Host $dirty
        Fail "Working tree is not clean. Commit or stash first - the release commit carries the version bump and nothing else."
    }

    $current = (Select-String -Path "$root\package.json" -Pattern '"version":\s*"([^"]+)"').Matches[0].Groups[1].Value
    if ($current -eq $Version) { Fail "Everything is already at $Version." }
    Step "Bumping $current -> $Version"

    # package.json files: the "version" field, plus every internal @zukunft/* range.
    # Both must move together. yarn workspaces resolves "@zukunft/domain": "0.1.0"
    # as an exact range, so bumping one without the other unlinks the workspace and
    # sends yarn to the registry for packages that were never published.
    $manifests = @(
        "package.json",
        "apps\desktop\package.json",
        "apps\desktop\next\package.json",
        "apps\web\next\package.json",
        "packages\domain\package.json",
        "packages\gantt\package.json",
        "packages\github\package.json",
        "apps\desktop\src-tauri\tauri.conf.json"
    )

    # Rewrite the matching lines rather than round-tripping through ConvertTo-Json,
    # which would reorder keys and reformat the whole file.
    foreach ($manifest in $manifests) {
        $full = Join-Path $root $manifest
        if ($DryRun) { Write-Host "    would update $manifest" -ForegroundColor DarkGray; continue }
        $text = Get-Content $full -Raw
        $text = $text -replace "(`"version`":\s*`")$([regex]::Escape($current))(`")", "`${1}$Version`${2}"
        $text = $text -replace "(`"@zukunft/[a-z-]+`":\s*`")$([regex]::Escape($current))(`")", "`${1}$Version`${2}"
        Set-Content -Path $full -Value $text -NoNewline
        Write-Host "    $manifest" -ForegroundColor DarkGray
    }

    # Cargo.toml - only the crate's own version line, which sits above [dependencies].
    $cargoPath = "$root\apps\desktop\src-tauri\Cargo.toml"
    if ($DryRun) {
        Write-Host "    would update apps\desktop\src-tauri\Cargo.toml" -ForegroundColor DarkGray
    }
    else {
        $cargo = Get-Content $cargoPath -Raw
        $cargo = $cargo -replace "(?m)^version = `"$([regex]::Escape($current))`"", "version = `"$Version`""
        Set-Content -Path $cargoPath -Value $cargo -NoNewline
        Write-Host "    apps\desktop\src-tauri\Cargo.toml" -ForegroundColor DarkGray
    }

    if ($DryRun) { Step "Dry run - nothing was written."; return }

    # yarn install relinks the workspace against the new version ranges.
    Step "yarn install"
    yarn install
    if ($LASTEXITCODE -ne 0) { Fail "yarn install failed. The bumped files are left in place for inspection." }

    Step "yarn verify (typecheck + tests)"
    yarn verify
    if ($LASTEXITCODE -ne 0) { Fail "Verification failed. The bumped files are left in place for inspection." }

    # Also refreshes Cargo.lock, which tracks the crate's own version and is committed.
    Step "cargo check"
    cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { Fail "cargo check failed. The bumped files are left in place for inspection." }

    Step "Committing and tagging $tag"
    git add -A
    git commit -m "chore: $tag"
    if ($LASTEXITCODE -ne 0) { Fail "git commit failed." }
    git tag -a $tag -m "Zukunft $tag"
    if ($LASTEXITCODE -ne 0) { Fail "git tag failed." }

    git --no-pager log --oneline -3

    if ($Push) {
        Step "Pushing main and $tag to origin"
        git push origin main
        if ($LASTEXITCODE -ne 0) { Fail "git push origin main failed." }
        git push origin $tag
        if ($LASTEXITCODE -ne 0) { Fail "git push origin $tag failed." }
    }
    else {
        Write-Host "Not pushed. When the log above looks right:" -ForegroundColor Yellow
        Write-Host "    git push origin main; git push origin $tag" -ForegroundColor Gray
    }
}

if (-not $building) { return }

# --------------------------------------------------------------------- staleness

# Everything the release binary is built from. A change to any of these means the
# exe on disk is out of date - including the icons, which are compiled into the
# Windows resource, and tauri.conf.json, which carries the version and the CSP.
# Generated trees are excluded: they are rewritten by merely building or running.
function Get-NewestSource {
    $paths = @(
        "$root\apps\desktop\src-tauri\src",
        "$root\apps\desktop\src-tauri\icons",
        "$root\apps\desktop\next\app",
        "$root\apps\desktop\next\src",
        "$root\packages\domain\src",
        "$root\packages\gantt\src",
        "$root\packages\github\src"
    ) | Where-Object { Test-Path $_ }

    $files = @()
    if ($paths) {
        $files += Get-ChildItem $paths -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\(node_modules|\.next|out|target)\\' }
    }
    foreach ($single in @("$root\apps\desktop\src-tauri\tauri.conf.json", "$root\apps\desktop\src-tauri\Cargo.toml")) {
        if (Test-Path $single) { $files += Get-Item $single }
    }
    $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# Only meaningful when we are NOT about to rebuild. With -Installer the build
# below makes the binary current by definition.
if ($Install -and -not $Installer -and -not $Force) {
    if (-not (Test-Path $exePath)) {
        Fail "There is no built zukunft.exe to install. Re-run with -Installer."
    }
    $exe = Get-Item $exePath
    $newest = Get-NewestSource
    if ($newest -and $newest.LastWriteTime -gt $exe.LastWriteTime) {
        Write-Host "`nSTALE BINARY - refusing to install an exe older than its sources." -ForegroundColor Red
        Write-Host "  built  $($exe.LastWriteTime)  zukunft.exe" -ForegroundColor Red
        Write-Host "  newer  $($newest.LastWriteTime)  $($newest.FullName.Substring($root.Length + 1))" -ForegroundColor Red
        Fail "Re-run with -Installer to rebuild first (or -Force if you are sure)."
    }
}

# ------------------------------------------------------------------------ build

if ($Installer) {
    # beforeBuildCommand runs the Next production build, so the UI is fresh too.
    Step "yarn tauri:build"
    yarn tauri:build
    if ($LASTEXITCODE -ne 0) { Fail "tauri build failed." }
}

$bundle = "$root\apps\desktop\src-tauri\target\release\bundle"
$nsis = Get-ChildItem "$bundle\nsis\*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$msi = Get-ChildItem "$bundle\msi\*.msi" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $nsis) { Fail "No NSIS installer under $bundle\nsis. Re-run with -Installer." }
Write-Host ""
Write-Host "installer (NSIS): $($nsis.FullName)" -ForegroundColor Green
if ($msi) { Write-Host "installer (MSI) : $($msi.FullName)" -ForegroundColor Green }

if (-not $Install) {
    Write-Host ""
    Write-Host "Not installed. To install it:" -ForegroundColor Yellow
    Write-Host "    .\release.ps1 -Install" -ForegroundColor Gray
    return
}

# ---------------------------------------------------------------------- install

# Windows will not overwrite a running exe, and NSIS SKIPS a file it cannot
# replace rather than failing - which leaves a half-updated install that looks
# exactly like a change that did not work.
Get-Process -Name "zukunft" -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Host "closing the running app (PID $($_.Id))" -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -Confirm:$false -ErrorAction SilentlyContinue
    }

# Wait for the handles to actually be released rather than hoping one second was enough.
$installedExe = Join-Path $InstallDir "zukunft.exe"
foreach ($attempt in 1..15) {
    if (-not (Test-Path $installedExe)) { break }
    try {
        $handle = [IO.File]::Open($installedExe, 'Open', 'ReadWrite', 'None')
        $handle.Close()
        break
    }
    catch {
        if ($attempt -eq 15) { Write-Host "zukunft.exe is still locked after 15s; installing anyway" -ForegroundColor Yellow }
        Start-Sleep -Seconds 1
    }
}

$expected = Get-ConfiguredVersion
Step "Installing $expected to $InstallDir"
# /S = silent, so this never waits on a dialog. /D = target dir; NSIS requires it
# LAST and unquoted, even when the path contains spaces. The installer removes the
# previous version by itself - do not uninstall by hand first.
Start-Process $nsis.FullName -ArgumentList "/S /D=$InstallDir" -Wait
Start-Sleep -Seconds 2

# ----------------------------------------------------------------- verification

if (-not (Test-Path $installedExe)) {
    Fail "zukunft.exe is not in $InstallDir. The installer may have used a different folder - check the uninstall entry under HKCU."
}

$built = Get-Item $exePath -ErrorAction SilentlyContinue
$shipped = Get-Item $installedExe
$registered = Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "*Zukunft*" } | Select-Object -First 1

$problems = @()
# Proves NSIS replaced the exe rather than skipping a locked one.
if ($built -and $built.Length -ne $shipped.Length) {
    $problems += "installed zukunft.exe ($($shipped.Length) bytes) does not match the one just built ($($built.Length) bytes)"
}
if ($registered -and $registered.DisplayVersion -ne $expected) {
    $problems += "the registry reports $($registered.DisplayVersion), expected $expected"
}

if ($problems) {
    Write-Host ""
    foreach ($problem in $problems) { Write-Host "PROBLEM: $problem" -ForegroundColor Red }
    Write-Host "Close the app completely and re-run: .\release.ps1 -Install" -ForegroundColor Yellow
    exit 1
}

# Explorer caches icons per executable path, so a new icon on the same path can
# keep showing the old one until the cache is rebuilt.
& ie4uinit.exe -show 2>$null

Write-Host ""
Write-Host "Installed Zukunft $expected to $InstallDir" -ForegroundColor Green
Write-Host "  exe    $($shipped.Length) bytes  $($shipped.LastWriteTime)" -ForegroundColor Gray
Write-Host "Launch it from the Start menu." -ForegroundColor Gray
