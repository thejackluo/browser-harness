$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
npm run build
if ($LASTEXITCODE) { throw 'Build failed' }
node scripts/build-desktop.mjs
if ($LASTEXITCODE) { throw 'Desktop bundle failed' }
$payload = Join-Path $repo 'build\desktop'
$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$node = (Get-Command node.exe).Source
Copy-Item $node (Join-Path $runtime 'node.exe')
$version = (& $node --version).Trim()
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/nodejs/node/$version/LICENSE" -OutFile (Join-Path $runtime 'LICENSE.txt')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /optimize+ "/out:$payload\BrowserHarnessHost.exe" (Join-Path $PSScriptRoot 'NativeLauncher.cs')
if ($LASTEXITCODE) { throw 'Native launcher build failed' }
$iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (-not (Test-Path $iscc)) { throw 'Install Inno Setup 6 to build the Windows installer.' }
& $iscc "/DPayload=$payload" (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE) { throw 'Installer build failed' }
