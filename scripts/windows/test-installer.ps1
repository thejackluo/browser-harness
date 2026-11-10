# CI-only installation test. Refuses to replace an existing native helper registration.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\io.browserharness.host'
if (Test-Path $registry) { throw 'A Browser Harness native helper is already registered. Use a clean Windows test account.' }
$install = Join-Path $env:TEMP 'Browser Harness installed test'
$installer = Join-Path $repo 'artifacts\BrowserHarnessSetup.exe'
$process = Start-Process $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $install + '"')) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
try {
  $manifestPath = (Get-Item $registry).GetValue('')
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name -ne 'io.browserharness.host' -or $manifest.allowed_origins[0] -ne 'chrome-extension://dhgboignmjemkhkhknadoeagnoaibloh/') { throw 'Native manifest trust boundary is incorrect' }
  $launcher = Join-Path $install $manifest.path
  $binary = [IO.File]::ReadAllBytes($launcher)
  $pe = [BitConverter]::ToInt32($binary, 0x3c)
  if ([BitConverter]::ToUInt16($binary, $pe + 24 + 68) -ne 2) { throw 'Launcher is not a windowless GUI-subsystem executable' }
  if (-not (Test-Path (Join-Path $install 'extension\manifest.json'))) { throw 'Packaged extension is missing' }
  $env:BROWSER_HARNESS_TEST_LAUNCHER = $launcher
  node --test dist/test/native.test.js
  if ($LASTEXITCODE) { throw 'Installed helper tests failed' }
}
finally {
  Remove-Item Env:\BROWSER_HARNESS_TEST_LAUNCHER -ErrorAction SilentlyContinue
  $uninstaller = Join-Path $install 'unins000.exe'
  if (Test-Path $uninstaller) { $result = Start-Process $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru }
}
if (Test-Path $registry) { throw 'Uninstall did not remove the native registration' }
Write-Host 'Self-contained Windows install, GUI launcher, authenticated API and uninstall checks passed.'
$global:LASTEXITCODE = 0
