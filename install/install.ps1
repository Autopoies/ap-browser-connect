# ap-browser-connect Windows installer.
#
# What it does:
#   1. Builds ap-browser-host.exe (release)
#   2. Copies it to $env:LOCALAPPDATA\ap-browser-connect\
#   3. Detects Chrome user-data-dir, derives extension ID, writes the
#      native messaging manifest with the correct allowed_origins
#   4. Registers the manifest path under
#      HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.apbrowser.connect
#
# Usage:
#   .\install\install.ps1                # install
#   .\install\install.ps1 -Uninstall     # remove

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$HostName = "com.apbrowser.connect"
$InstallDir = Join-Path $env:LOCALAPPDATA "ap-browser-connect"
$HostExe = Join-Path $InstallDir "ap-browser-host.exe"
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$RegKey = "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$HostName"
$ChromeUserData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"

function Uninstall-Host {
    Write-Host "-> Removing native messaging registry key"
    if (Test-Path $RegKey) { Remove-Item -Path $RegKey -Recurse -Force }
    Write-Host "-> Removing manifest"
    if (Test-Path $ManifestPath) { Remove-Item -Path $ManifestPath -Force }
    Write-Host "-> Removing install dir"
    if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
    Write-Host "[ok] Uninstalled. The extension itself can be removed from chrome://extensions."
    exit 0
}

if ($Uninstall) { Uninstall-Host }

# --- 1. Build ---------------------------------------------------------------
Write-Host "-> Building ap-browser-host (release)..."
Push-Location $RepoRoot
& cargo build --release -p ap-browser-host
$exitCode = $LASTEXITCODE
Pop-Location
if ($exitCode -ne 0) { throw "cargo build failed (exit $exitCode)" }

$BuiltExe = Join-Path $RepoRoot "target\release\ap-browser-host.exe"
if (-not (Test-Path $BuiltExe)) { throw "Build output not found: $BuiltExe" }

# --- 2. Install dir + copy exe ---------------------------------------------
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
Copy-Item -Path $BuiltExe -Destination $HostExe -Force
Write-Host "-> Installed host binary to $HostExe"

# --- 3. Find extension ID in Chrome Preferences ----------------------------
function Get-ExtensionId {
    param([string]$PrefsPath)
    if (-not (Test-Path $PrefsPath)) { return $null }
    try {
        $raw = Get-Content -Raw -LiteralPath $PrefsPath
        $prefs = $raw | ConvertFrom-Json
    } catch { return $null }
    $settings = $prefs.extensions.settings
    if (-not $settings) { return $null }
    foreach ($prop in $settings.PSObject.Properties) {
        $ext = $prop.Value
        if ($ext.manifest -and $ext.manifest.name -eq "ap-browser-connect") {
            return $prop.Name
        }
    }
    return $null
}

$ExtId = $null
foreach ($profile in @("Default", "Profile 1", "Profile 2", "Profile 3")) {
    $prefs = Join-Path $ChromeUserData "$profile\Preferences"
    $ExtId = Get-ExtensionId -PrefsPath $prefs
    if ($ExtId) { break }
}

if (-not $ExtId) {
    Write-Warning "Could not auto-detect extension ID."
    Write-Warning "   Load the extension unpacked at chrome://extensions first, then re-run this installer."
    Write-Warning "   Or edit $ManifestPath manually and replace REPLACE_WITH_EXTENSION_ID."
    $ExtId = "REPLACE_WITH_EXTENSION_ID"
} else {
    Write-Host "   Extension ID: $ExtId"
}

# --- 4. Write manifest ------------------------------------------------------
$manifest = [ordered]@{
    name = $HostName
    description = "ap-browser-connect native messaging host"
    path = $HostExe
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
Write-Host "-> Wrote manifest to $ManifestPath"

# --- 5. Register in registry ------------------------------------------------
if (-not (Test-Path $RegKey)) { New-Item -Path $RegKey -Force | Out-Null }
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath
Write-Host "-> Registered manifest in registry: $RegKey"

Write-Host ""
Write-Host "[ok] Done. Next:"
Write-Host "  1. Load the extension unpacked at: $RepoRoot\extension"
Write-Host "  2. Open the extension popup to set a label"
Write-Host "  3. Verify with: ap-browser ping"
Write-Host ""
Write-Host "If the extension ID changes (e.g. new load path), re-run this script."
