# Offline regression checks on native Windows PowerShell 5.1. No browser or provider account.
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$testHome = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$repo = Join-Path $testHome 'browser-harness'
$previousHome = $env:USERPROFILE
$previousHarnessHome = $env:BROWSER_HARNESS_HOME
$previousApiKey = $env:BROWSER_HARNESS_API_KEY
$previousBridge = $env:BROWSER_HARNESS_BRIDGE_TOKEN
$previousLocation = Get-Location
New-Item -ItemType Directory $testHome | Out-Null
New-Item -ItemType Junction -Path $repo -Target $source | Out-Null

# Avoid clone/update, installs, launching servers, or changing the real clipboard.
function git { $global:LASTEXITCODE = 0 }
function npm { $global:LASTEXITCODE = 0 }
function Set-Clipboard { param($Value) }

try {
  $env:USERPROFILE = $testHome
  $env:BROWSER_HARNESS_API_KEY = 'stale-environment-key'
  & "$source\scripts\windows\setup-and-start.ps1"
  $keyDir = Join-Path $testHome '.browser-harness'
  $keys = Get-Content (Join-Path $keyDir 'keys.json') -Raw | ConvertFrom-Json
  $configFile = Join-Path $testHome '.config\opencode\opencode.json'
  $config = Get-Content $configFile -Raw | ConvertFrom-Json
  $expected = '{file:' + (Join-Path $keyDir 'api_key') + '}'
  if ($config.provider.'browser-harness'.options.apiKey -ne $expected) { throw 'Config must use the key file, not a process-only env var.' }
  if ((Get-Content (Join-Path $keyDir 'api_key') -Raw) -ne $keys.api) { throw 'OpenCode and gateway keys must match.' }
  if ([System.IO.File]::ReadAllBytes($configFile)[0] -ne 123) { throw 'OpenCode JSON must have no UTF-8 BOM.' }
  if ($env:BROWSER_HARNESS_API_KEY -ne $keys.api) { throw 'Gateway must use helper keys.' }
  $apiKeyFile = Join-Path $keyDir 'api_key'
  $acl = Get-Acl $apiKeyFile
  if (-not $acl.AreAccessRulesProtected) { throw 'API key file must not inherit ACLs.' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if (@($rules | Where-Object { $_.IdentityReference -ne $sid }).Count) { throw 'Unexpected API key ACL principal.' }
  $originalConfig = Get-Content $configFile -Raw
  $keys.api = 'rotated-test-key'
  $keys | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $keyDir 'keys.json')
  & "$source\scripts\windows\setup-and-start.ps1"
  if ((Get-Content $configFile -Raw) -ne $originalConfig) { throw 'Existing JSON config changed.' }
  if ((Get-Content $apiKeyFile -Raw) -ne $keys.api) { throw 'Existing OpenCode config must follow key rotation.' }
  Remove-Item $configFile
  Set-Content (Join-Path (Split-Path $configFile) 'opencode.jsonc') '// existing config'
  & "$source\scripts\windows\setup-and-start.ps1"
  if (Test-Path $configFile) { throw 'Must not shadow existing JSONC config.' }

  # smoke.ps1 exits with npm's status; use an isolated process to exercise it.
  $smokePath = "$source\scripts\windows\smoke.ps1"
  foreach ($model in @('chatgpt-browser', 'gemini-browser')) {
    $escapedPath = $smokePath.Replace("'", "''")
    $command = @"
function npm {
  # PowerShell consumes -- for functions; native npm.cmd receives it literally.
  if ((`$args -join ' ') -ne 'run smoke $model') { throw 'Wrong smoke arguments' }
  `$global:LASTEXITCODE = 7
}
& '$escapedPath' -Model $model
"@
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 7) { throw "Smoke did not preserve npm's exit code for $model." }
  }
  Write-Host 'Windows regression checks passed.'
}
finally {
  Set-Location $previousLocation
  $env:USERPROFILE = $previousHome
  $env:BROWSER_HARNESS_HOME = $previousHarnessHome
  $env:BROWSER_HARNESS_API_KEY = $previousApiKey
  $env:BROWSER_HARNESS_BRIDGE_TOKEN = $previousBridge
  [System.IO.Directory]::Delete($repo)
  Remove-Item -Recurse -Force $testHome
}
