$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundleDir = Join-Path $RootDir 'src-tauri\target\release\bundle'

function Write-Log {
  param([string]$Message)
  Write-Host "[apkworkshop] $Message"
}

function Fail {
  param([string]$Message)
  throw "[apkworkshop] $Message"
}

function Write-Warn {
  param([string]$Message)
  Write-Warning "[apkworkshop] $Message"
}

function Test-CommandExists {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-SessionPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($machinePath) { $parts += $machinePath }
  if ($userPath) { $parts += $userPath }
  if ($parts.Count -gt 0) {
    $env:Path = ($parts -join ';')
  }
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if ((Test-Path $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) {
    $env:Path = "$cargoBin;$env:Path"
  }
}

function Ensure-Winget {
  if (Test-CommandExists 'winget') {
    return
  }
  Fail 'winget was not found. Please install App Installer from Microsoft Store and try again.'
}

function Install-WingetPackage {
  param(
    [string]$Id,
    [string]$Label,
    [string[]]$ExtraArgs = @(),
    [switch]$AllowFailure
  )

  Write-Log "Installing $Label ..."
  $args = @(
    'install',
    '--id', $Id,
    '-e',
    '--accept-package-agreements',
    '--accept-source-agreements'
  ) + $ExtraArgs

  & winget @args
  if ($LASTEXITCODE -ne 0) {
    if ($AllowFailure) {
      Write-Warn "$Label installation returned exit code $LASTEXITCODE."
      return $false
    }
    Fail "$Label installation failed. winget exit code: $LASTEXITCODE"
  }
  return $true
}

function Ensure-Node {
  if (Test-CommandExists 'npm') {
    Write-Log 'npm detected'
    return
  }

  Ensure-Winget
  Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Label 'Node.js LTS' -ExtraArgs @('--silent')
  Refresh-SessionPath

  if (-not (Test-CommandExists 'npm')) {
    Fail 'Node.js was installed but npm is still unavailable in the current session. Please reopen the terminal and try again.'
  }
}

function Ensure-Rustup {
  $hasCargo = Test-CommandExists 'cargo'
  $hasRustc = Test-CommandExists 'rustc'
  if ($hasCargo -and $hasRustc) {
    Write-Log 'Rust toolchain detected'
    return
  }

  Ensure-Winget
  Install-WingetPackage -Id 'Rustlang.Rustup' -Label 'Rustup / Rust' -ExtraArgs @('--silent')
  Refresh-SessionPath

  if (-not (Test-CommandExists 'rustup')) {
    Fail 'Rust was installed but rustup is still unavailable in the current session. Please reopen the terminal and try again.'
  }
}

function Ensure-RustToolchain {
  if (-not (Test-CommandExists 'rustup')) {
    Fail 'rustup is unavailable.'
  }

  & rustup toolchain install stable-x86_64-pc-windows-msvc --profile minimal
  if ($LASTEXITCODE -ne 0) {
    Fail 'Failed to install the stable-x86_64-pc-windows-msvc toolchain.'
  }

  & rustup default stable-x86_64-pc-windows-msvc | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail 'Failed to switch Rust to stable-x86_64-pc-windows-msvc.'
  }

  & rustc -V | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail 'rustc is unavailable after configuring the MSVC toolchain.'
  }
}

function Get-VsWherePath {
  $installerDir = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
  $vsWhere = Join-Path $installerDir 'vswhere.exe'
  if (Test-Path $vsWhere) {
    return $vsWhere
  }
  return $null
}

function Get-VsInstallPath {
  $vsWhere = Get-VsWherePath
  if (-not $vsWhere) {
    return $null
  }

  $installPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0) {
    return $null
  }

  if ([string]::IsNullOrWhiteSpace($installPath)) {
    return $null
  }
  return $installPath.Trim()
}

function Ensure-VsBuildTools {
  $installPath = Get-VsInstallPath
  if ($installPath) {
    Write-Log 'Visual Studio C++ Build Tools detected'
    return $installPath
  }

  Ensure-Winget
  Install-WingetPackage `
    -Id 'Microsoft.VisualStudio.2022.BuildTools' `
    -Label 'Visual Studio 2022 Build Tools' `
    -ExtraArgs @(
      '--override',
      '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    )

  $installPath = Get-VsInstallPath
  if (-not $installPath) {
    Fail 'Visual Studio Build Tools was installed but the C++ toolchain is still unavailable.'
  }
  return $installPath
}

function Import-VsDevEnvironment {
  param([string]$InstallPath)

  $vsDevCmd = Join-Path $InstallPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) {
    Fail "VsDevCmd.bat was not found: $vsDevCmd"
  }

  Write-Log 'Loading MSVC build environment...'
  $cmdOutput = cmd.exe /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    Fail 'Failed to load the Visual Studio build environment.'
  }

  foreach ($line in $cmdOutput) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

function Test-WebView2RuntimeInstalled {
  $registryPaths = @(
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  )

  foreach ($path in $registryPaths) {
    if (Test-Path $path) {
      return $true
    }
  }

  $runtimePaths = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'),
    (Join-Path $env:ProgramFiles 'Microsoft\EdgeWebView\Application'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\EdgeWebView\Application')
  )

  foreach ($path in $runtimePaths) {
    if ($path -and (Test-Path $path)) {
      return $true
    }
  }

  return $false
}

function Ensure-WebView2 {
  if (Test-WebView2RuntimeInstalled) {
    Write-Log 'WebView2 Runtime detected'
    return
  }

  Ensure-Winget
  $installed = Install-WingetPackage `
    -Id 'Microsoft.EdgeWebView2Runtime' `
    -Label 'WebView2 Runtime' `
    -ExtraArgs @('--silent') `
    -AllowFailure

  if ($installed) {
    return
  }

  if (Test-WebView2RuntimeInstalled) {
    Write-Log 'WebView2 Runtime detected after winget returned a non-zero exit code'
    return
  }

  Write-Warn 'WebView2 Runtime could not be installed automatically. Build will continue, but the app may require WebView2 on the target machine.'
}

function Ensure-NodeModules {
  $nodeModules = Join-Path $RootDir 'node_modules'
  if (Test-Path $nodeModules) {
    return
  }

  Write-Log 'node_modules not found. Installing frontend dependencies...'
  Push-Location $RootDir
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) {
      Fail 'npm install failed.'
    }
  } finally {
    Pop-Location
  }
}

function Invoke-TauriBuild {
  Push-Location $RootDir
  try {
    Write-Log 'Running Tauri build...'
    & npm run tauri:build
    if ($LASTEXITCODE -ne 0) {
      Fail 'npm run tauri:build failed.'
    }
  } finally {
    Pop-Location
  }
}

function Show-Artifacts {
  if (-not (Test-Path $BundleDir)) {
    Fail "Bundle output directory was not found: $BundleDir"
  }

  Write-Log "Build finished. Artifact directory: $BundleDir"
  $artifacts = Get-ChildItem -Path $BundleDir -Recurse -File -Include *.exe, *.msi
  if (-not $artifacts) {
    Write-Log 'No .exe or .msi artifacts were found. Please check the Tauri build output.'
    return
  }

  foreach ($artifact in $artifacts) {
    Write-Host "  - $($artifact.FullName)"
  }
}

Write-Log 'APK Workshop Windows build helper'
Write-Log "Project directory: $RootDir"

Refresh-SessionPath
Ensure-Winget
Ensure-Node
Ensure-Rustup
$vsInstallPath = Ensure-VsBuildTools
Import-VsDevEnvironment -InstallPath $vsInstallPath
Ensure-RustToolchain
Ensure-WebView2
Ensure-NodeModules
Invoke-TauriBuild
Show-Artifacts
