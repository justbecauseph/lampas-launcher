# Packaging and local testing script for Windows Store (AppX/MSIX)
$ErrorActionPreference = "Stop"

Write-Host "Building AppX package..." -ForegroundColor Cyan
bun run package:appx

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$appx = "release\LampasLauncher-$version-Windows.appx"

Write-Host "Locating signtool..." -ForegroundColor Cyan
$signtool = (Get-ChildItem -Path "$env:LOCALAPPDATA\electron-builder" -Recurse -Filter "signtool.exe" | Where-Object { $_.FullName -match '\\x64\\signtool\.exe' } | Select-Object -First 1).FullName

if (-not (Test-Path "devcert.pfx")) {
    Write-Error "devcert.pfx not found. Make sure the development certificate exists."
}

Write-Host "Signing AppX for local testing..." -ForegroundColor Cyan
& $signtool sign /fd SHA256 /a /f devcert.pfx /p devpass123! $appx

Write-Host "Installing/Updating AppX package..." -ForegroundColor Cyan
Add-AppxPackage -Path $appx

Write-Host "Installed successfully! Launch from Start menu or run: Start-Process 'shell:AppsFolder\59450PUPProgGuild.LampasLauncher_bdagfy06snw12!LampasLauncher'" -ForegroundColor Green
