# Browser Harness: clone/update, build, and start the local gateway (Windows PowerShell 5.1+).
$ErrorActionPreference = 'Stop'
$repo = Join-Path $env:USERPROFILE 'browser-harness'
$keyDir = Join-Path $env:USERPROFILE '.browser-harness'
$keyFile = Join-Path $keyDir 'keys.json'

if (Test-Path $repo) { git -C $repo checkout main; git -C $repo pull --ff-only }
else { git clone https://github.com/thejackluo/browser-harness.git $repo }
Set-Location $repo
npm ci --ignore-scripts
if ($LASTEXITCODE) { throw 'npm ci failed' }
npm run build
if ($LASTEXITCODE) { throw 'build failed' }

if (-not (Test-Path $keyFile)) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  $gen = { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" }
  @{ api = (& $gen); bridge = (& $gen) } | ConvertTo-Json | Set-Content -Encoding ascii $keyFile
  icacls $keyFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
}
$keys = Get-Content $keyFile -Raw | ConvertFrom-Json
$env:BROWSER_HARNESS_API_KEY = $keys.api
$env:BROWSER_HARNESS_BRIDGE_TOKEN = $keys.bridge
Set-Clipboard -Value $keys.bridge

Write-Host ''
Write-Host "Extension folder: $repo\build\extension" -ForegroundColor Cyan
Write-Host 'The bridge token is on your clipboard. Paste it into the extension popup.' -ForegroundColor Cyan
Write-Host 'Keep this window open. Press Ctrl+C to stop the gateway.' -ForegroundColor Cyan
npm start
