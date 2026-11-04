# Browser Harness: clone/update, build, connect OpenCode, and start the local gateway (Windows PowerShell 5.1+).
# After the first run, the "Browser Harness" desktop shortcut runs this script again.
param([string]$ShortcutDir = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
foreach ($command in @('git', 'node', 'npm')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Install $command first, then reopen PowerShell and rerun this script."
  }
}
$repo = Join-Path $env:USERPROFILE 'browser-harness'
$keyDir = Join-Path $env:USERPROFILE '.browser-harness'
$keyFile = Join-Path $keyDir 'keys.json'

if (Test-Path $repo) {
  $changes = git -C $repo status --porcelain
  if ($LASTEXITCODE -or $changes) { throw 'Repository has local changes or is not a Git repo; commit or stash before updating.' }
  git -C $repo checkout main
  if ($LASTEXITCODE) { throw 'git checkout main failed; commit or stash local changes first' }
  git -C $repo pull --ff-only
  if ($LASTEXITCODE) { throw 'git pull failed' }
}
else {
  git clone https://github.com/thejackluo/browser-harness.git $repo
  if ($LASTEXITCODE) { throw 'git clone failed' }
}
Set-Location $repo
npm ci --ignore-scripts
if ($LASTEXITCODE) { throw 'npm ci failed' }
npm run build
if ($LASTEXITCODE) { throw 'build failed' }

if (-not (Test-Path $keyFile)) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  $gen = { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" }
  @{ api = (& $gen) } | ConvertTo-Json | Set-Content -Encoding ascii $keyFile
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $keyDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict permissions on the local key directory.' }
icacls $keyFile /inheritance:r /grant:r "*${sid}:F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict permissions on the local key file.' }
$keys = Get-Content $keyFile -Raw | ConvertFrom-Json
if (-not $keys.api) { throw 'Local keys.json must contain a nonempty api key.' }
$env:BROWSER_HARNESS_HOME = $keyDir
$env:BROWSER_HARNESS_API_KEY = $keys.api
$env:BROWSER_HARNESS_BRIDGE_TOKEN = $null
$baseUrl = 'http://127.0.0.1:4318/v1'

# Adds only the browser-harness provider; other OpenCode settings are kept.
node dist/src/cli.js setup opencode
if ($LASTEXITCODE) { Write-Warning 'OpenCode was not configured automatically (see the message above).' }
$apiKeyFile = Join-Path $keyDir 'api_key'
icacls $apiKeyFile /inheritance:r /grant:r "*${sid}:F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict permissions on the OpenCode key file.' }

if (Get-Command hermes -ErrorAction SilentlyContinue) {
  $hermesUrl = (hermes config get model.base_url 2>$null | Out-String).Trim()
  if ($hermesUrl -ne $baseUrl) { Write-Host "Hermes found. To use Browser Harness in Hermes, run once: cd $repo; npm run setup -- hermes" -ForegroundColor Yellow }
}

if ($ShortcutDir) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $ShortcutDir 'Browser Harness.lnk'))
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$repo\scripts\windows\setup-and-start.ps1`""
  $link.WorkingDirectory = $repo
  $link.Description = 'Update and start the Browser Harness gateway'
  $link.Save()
}

Write-Host ''
Write-Host 'Next:' -ForegroundColor Cyan
Write-Host "  1. First time only: chrome://extensions -> Developer mode -> Load unpacked -> $repo\build\extension" -ForegroundColor Cyan
Write-Host '     After an update, click Reload on Browser Harness there and refresh your ChatGPT/Gemini tabs.' -ForegroundColor Cyan
Write-Host '  2. In a ChatGPT or Gemini tab, click the Browser Harness extension, then "Arm this tab".' -ForegroundColor Cyan
Write-Host "  3. Check everything from a second window: cd $repo; npm run doctor" -ForegroundColor Cyan
Write-Host 'Keep this window open. Press Ctrl+C to stop the gateway. Next time, use the Browser Harness desktop shortcut.' -ForegroundColor Cyan
npm start
