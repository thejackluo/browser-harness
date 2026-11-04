# Browser Harness: clone/update, build, and start the local gateway (Windows PowerShell 5.1+).
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
  @{ api = (& $gen); bridge = (& $gen) } | ConvertTo-Json | Set-Content -Encoding ascii $keyFile
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $keyDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict permissions on the local key directory.' }
icacls $keyFile /inheritance:r /grant:r "*${sid}:F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict permissions on the local key file.' }
$keys = Get-Content $keyFile -Raw | ConvertFrom-Json
if (-not $keys.api -or -not $keys.bridge) { throw 'Local keys.json must contain nonempty api and bridge keys.' }
$env:BROWSER_HARNESS_HOME = $keyDir
$previousApiKey = $env:BROWSER_HARNESS_API_KEY
try {
  $env:BROWSER_HARNESS_API_KEY = $null
  node dist/src/cli.js key | Out-Null
  if ($LASTEXITCODE) { throw 'Synchronizing the OpenCode key file failed.' }
}
finally {
  $env:BROWSER_HARNESS_API_KEY = $previousApiKey
}
$apiKeyFile = Join-Path $keyDir 'api_key'
icacls $apiKeyFile /inheritance:r /grant:r "*${sid}:F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict permissions on the OpenCode key file.' }
$opencodeDir = Join-Path $env:USERPROFILE '.config\opencode'
$opencodeFile = Join-Path $opencodeDir 'opencode.json'
if (-not ((Test-Path $opencodeFile) -or (Test-Path (Join-Path $opencodeDir 'opencode.jsonc')))) {
  New-Item -ItemType Directory -Force $opencodeDir | Out-Null
  $previousApiKey = $env:BROWSER_HARNESS_API_KEY
  try {
    # Use a file reference so OpenCode works in a second PowerShell window too.
    $env:BROWSER_HARNESS_API_KEY = $null
    $config = node dist/src/cli.js opencode
    if ($LASTEXITCODE) { throw 'Generating the OpenCode config failed.' }
    [System.IO.File]::WriteAllText($opencodeFile, ($config -join "`n"), (New-Object System.Text.UTF8Encoding $false))
  }
  finally {
    $env:BROWSER_HARNESS_API_KEY = $previousApiKey
  }
  Write-Host "Wrote OpenCode config: $opencodeFile" -ForegroundColor Cyan
}
else {
  Write-Host "OpenCode config already exists; merge in the output of 'npm run -s opencode' from $repo" -ForegroundColor Yellow
}
$env:BROWSER_HARNESS_API_KEY = $keys.api
$env:BROWSER_HARNESS_BRIDGE_TOKEN = $keys.bridge
Set-Clipboard -Value $keys.bridge

Write-Host ''
Write-Host "Extension folder: $repo\build\extension" -ForegroundColor Cyan
Write-Host 'The bridge token is on your clipboard. Paste it into the extension popup.' -ForegroundColor Cyan
Write-Host 'Keep this window open. Press Ctrl+C to stop the gateway.' -ForegroundColor Cyan
npm start
