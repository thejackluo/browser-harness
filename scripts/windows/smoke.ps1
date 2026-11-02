# Browser Harness: run the read-only two-turn tool smoke test against the paired ChatGPT tab.
$ErrorActionPreference = 'Stop'
$repo = Join-Path $env:USERPROFILE 'browser-harness'
$keys = Get-Content (Join-Path $env:USERPROFILE '.browser-harness\keys.json') -Raw | ConvertFrom-Json
$env:BROWSER_HARNESS_API_KEY = $keys.api
Set-Location $repo
$started = Get-Date
npm run smoke
$code = $LASTEXITCODE
Write-Host ("Exit code {0}; took {1:n0}s" -f $code, ((Get-Date) - $started).TotalSeconds)
exit $code
