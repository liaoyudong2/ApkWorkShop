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
  Fail '缺少 winget。请先通过 Microsoft Store 安装 App Installer 后再重新运行。'
}

function Install-WingetPackage {
  param(
    [string]$Id,
    [string]$Label,
    [string[]]$ExtraArgs = @()
  )

  Write-Log "开始安装 $Label ..."
  $args = @(
    'install',
    '--id', $Id,
    '-e',
    '--accept-package-agreements',
    '--accept-source-agreements'
  ) + $ExtraArgs

  & winget @args
  if ($LASTEXITCODE -ne 0) {
    Fail "$Label 安装失败，winget 退出码: $LASTEXITCODE"
  }
}

function Ensure-Node {
  if (Test-CommandExists 'npm') {
    Write-Log '已检测到 npm'
    return
  }

  Ensure-Winget
  Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Label 'Node.js LTS' -ExtraArgs @('--silent')
  Refresh-SessionPath

  if (-not (Test-CommandExists 'npm')) {
    Fail 'Node.js 安装完成后仍未检测到 npm，请重新打开终端后再试。'
  }
}

function Ensure-Rust {
  $hasCargo = Test-CommandExists 'cargo'
  $hasRustc = Test-CommandExists 'rustc'
  if ($hasCargo -and $hasRustc) {
    Write-Log '已检测到 Rust 工具链'
  } else {
    Ensure-Winget
    Install-WingetPackage -Id 'Rustlang.Rustup' -Label 'Rustup / Rust' -ExtraArgs @('--silent')
    Refresh-SessionPath
  }

  if (-not (Test-CommandExists 'rustup')) {
    Fail 'Rust 已安装但当前会话未识别 rustup，请重新打开终端后再试。'
  }

  & rustup default stable-x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) {
    Fail '设置 Rust MSVC 工具链失败。'
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
    Write-Log '已检测到 Visual Studio C++ Build Tools'
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
    Fail 'Visual Studio Build Tools 安装后仍未检测到 C++ 工具链。'
  }
  return $installPath
}

function Import-VsDevEnvironment {
  param([string]$InstallPath)

  $vsDevCmd = Join-Path $InstallPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) {
    Fail "未找到 VsDevCmd.bat: $vsDevCmd"
  }

  Write-Log '加载 MSVC 构建环境...'
  $cmdOutput = cmd.exe /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    Fail '加载 Visual Studio 构建环境失败。'
  }

  foreach ($line in $cmdOutput) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

function Ensure-WebView2 {
  $webViewReg = 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  if (Test-Path $webViewReg) {
    Write-Log '已检测到 WebView2 Runtime'
    return
  }

  Ensure-Winget
  Install-WingetPackage -Id 'Microsoft.EdgeWebView2Runtime' -Label 'WebView2 Runtime' -ExtraArgs @('--silent')
}

function Ensure-NodeModules {
  $nodeModules = Join-Path $RootDir 'node_modules'
  if (Test-Path $nodeModules) {
    return
  }

  Write-Log '未发现 node_modules，开始安装前端依赖...'
  Push-Location $RootDir
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) {
      Fail 'npm install 执行失败。'
    }
  } finally {
    Pop-Location
  }
}

function Invoke-TauriBuild {
  Push-Location $RootDir
  try {
    Write-Log '开始执行 Tauri 打包...'
    & npm run tauri:build
    if ($LASTEXITCODE -ne 0) {
      Fail 'npm run tauri:build 执行失败。'
    }
  } finally {
    Pop-Location
  }
}

function Show-Artifacts {
  if (-not (Test-Path $BundleDir)) {
    Fail "未发现产物目录: $BundleDir"
  }

  Write-Log "打包完成，产物目录: $BundleDir"
  $artifacts = Get-ChildItem -Path $BundleDir -Recurse -File -Include *.exe, *.msi
  if (-not $artifacts) {
    Write-Log '未找到 .exe / .msi 产物，请检查 Tauri 构建输出。'
    return
  }

  foreach ($artifact in $artifacts) {
    Write-Host "  - $($artifact.FullName)"
  }
}

Write-Log 'APK Workshop Windows 一键打包'
Write-Log "项目目录: $RootDir"

Refresh-SessionPath
Ensure-Winget
Ensure-Node
Ensure-Rust
$vsInstallPath = Ensure-VsBuildTools
Import-VsDevEnvironment -InstallPath $vsInstallPath
Ensure-WebView2
Ensure-NodeModules
Invoke-TauriBuild
Show-Artifacts
