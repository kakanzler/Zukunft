# Cut a Zukunft release: bump every version in the workspace, verify, commit and tag.
#
#   .\release.ps1 0.1.1            Bump, verify, commit and tag. Does not push.
#   .\release.ps1 0.1.1 -Push      ... and push main and the tag to origin.
#   .\release.ps1 0.1.1 -DryRun    Print what would change and stop.
#
# The working tree must be clean before running: the release commit should carry
# the version bump and nothing else. Commit your feature work first.
#
# Building the installer (yarn tauri:build) and publishing a GitHub Release are
# deliberately not part of this script - do those by hand when you want them.

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$Push,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$tag = "v$Version"

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Fail($message) { Write-Host $message -ForegroundColor Red; exit 1 }

# ---- Preflight -------------------------------------------------------------

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Version must look like 1.2.3 (got '$Version')."
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") {
    Fail "On branch '$branch'. Releases are cut from main."
}

if (git tag --list $tag) {
    Fail "Tag $tag already exists."
}

$dirty = git status --porcelain
if ($dirty -and -not $DryRun) {
    Write-Host $dirty
    Fail "Working tree is not clean. Commit or stash before releasing."
}

# The version currently in the root package.json is what we replace everywhere.
$current = (Select-String -Path "$root\package.json" -Pattern '"version":\s*"([^"]+)"').Matches[0].Groups[1].Value
if ($current -eq $Version) {
    Fail "Everything is already at $Version."
}
Step "Bumping $current -> $Version"

# ---- Version bump ----------------------------------------------------------

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
    "packages\github\package.json"
)

# Rewrite the matching lines rather than round-tripping through ConvertTo-Json,
# which would reorder keys and reformat the whole file.
function Set-Manifest($path, $from, $to) {
    $full = Join-Path $root $path
    $text = Get-Content $full -Raw
    $text = $text -replace "(`"version`":\s*`")$([regex]::Escape($from))(`")", "`${1}$to`${2}"
    $text = $text -replace "(`"@zukunft/[a-z-]+`":\s*`")$([regex]::Escape($from))(`")", "`${1}$to`${2}"
    if ($DryRun) {
        Write-Host "    would update $path" -ForegroundColor DarkGray
    } else {
        Set-Content -Path $full -Value $text -NoNewline
        Write-Host "    $path" -ForegroundColor DarkGray
    }
}

foreach ($manifest in $manifests) { Set-Manifest $manifest $current $Version }

# tauri.conf.json carries the version shown in the installer and the app.
Set-Manifest "apps\desktop\src-tauri\tauri.conf.json" $current $Version

# Cargo.toml - only the crate's own version line, which sits above [dependencies].
$cargoPath = "$root\apps\desktop\src-tauri\Cargo.toml"
if ($DryRun) {
    Write-Host "    would update apps\desktop\src-tauri\Cargo.toml" -ForegroundColor DarkGray
} else {
    $cargo = Get-Content $cargoPath -Raw
    $cargo = $cargo -replace "(?m)^version = `"$([regex]::Escape($current))`"", "version = `"$Version`""
    Set-Content -Path $cargoPath -Value $cargo -NoNewline
    Write-Host "    apps\desktop\src-tauri\Cargo.toml" -ForegroundColor DarkGray
}

if ($DryRun) {
    Step "Dry run - nothing was written."
    return
}

# ---- Verify ----------------------------------------------------------------

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

Step "yarn build:desktop"
yarn build:desktop
if ($LASTEXITCODE -ne 0) { Fail "The desktop build failed. The bumped files are left in place for inspection." }

# ---- Commit and tag --------------------------------------------------------

Step "Committing and tagging $tag"
git add -A
git commit -m "chore: $tag"
if ($LASTEXITCODE -ne 0) { Fail "git commit failed." }

git tag -a $tag -m "Zukunft $tag"
if ($LASTEXITCODE -ne 0) { Fail "git tag failed." }

git --no-pager log --oneline -3
git --no-pager show --stat --no-patch $tag

# ---- Push ------------------------------------------------------------------

if (-not $Push) {
    Write-Host ""
    Write-Host "Not pushed. When the diff above looks right:" -ForegroundColor Yellow
    Write-Host "    git push origin main; git push origin $tag" -ForegroundColor Yellow
    return
}

Step "Pushing main and $tag to origin"
git push origin main
if ($LASTEXITCODE -ne 0) { Fail "git push origin main failed." }
git push origin $tag
if ($LASTEXITCODE -ne 0) { Fail "git push origin $tag failed." }

Write-Host "Released $tag." -ForegroundColor Green
