@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "PS_SCRIPT=%ROOT_DIR%\build-windows.ps1"

if not exist "%PS_SCRIPT%" (
  echo [apkworkshop] 未找到脚本: %PS_SCRIPT% 1>&2
  exit /b 1
)

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
  exit /b %errorlevel%
)

where powershell >nul 2>nul
if %errorlevel%==0 (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
  exit /b %errorlevel%
)

echo [apkworkshop] 未找到 PowerShell 或 pwsh，请先安装 PowerShell。 1>&2
exit /b 1
