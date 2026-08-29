<#
.SYNOPSIS
    Removes everything install.ps1 created. Leaves the repo folder in place.

.EXAMPLE
    .\uninstall.ps1
#>

[CmdletBinding()]
param([switch]$KeepSkill)

$ErrorActionPreference = 'Continue'
$Root     = $PSScriptRoot
$TaskName = 'KiroBrowserBridge'
$KiroHome = Join-Path $env:USERPROFILE '.kiro'

function Step { param($m) Write-Host "`n=== $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "    [ok] $m" -ForegroundColor Green }
function Info { param($m) Write-Host "         $m" -ForegroundColor Gray }

Step 'Stopping the bridge'
Get-CimInstance Win32_Process -Filter "Name like '%python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*bridge_server.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Ok "killed pid $($_.ProcessId)" }

Step 'Removing scheduled task'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok $TaskName
} else { Info 'not present' }

Step 'Removing MCP registration'
$mcpPath = Join-Path $KiroHome 'settings\mcp.json'
if (Test-Path $mcpPath) {
    try {
        $cfg = Get-Content -Raw -LiteralPath $mcpPath | ConvertFrom-Json
        if ($cfg.mcpServers -and $cfg.mcpServers.PSObject.Properties.Name -contains 'browser-bridge') {
            $cfg.mcpServers.PSObject.Properties.Remove('browser-bridge')
            $cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mcpPath -Encoding UTF8
            Ok "removed 'browser-bridge' from mcp.json"
        } else { Info 'entry not present' }
    } catch { Info "could not parse mcp.json - left alone" }
} else { Info 'mcp.json not present' }

Step 'Removing skill'
if ($KeepSkill) { Info 'kept (-KeepSkill)' }
else {
    $skillDir = Join-Path $KiroHome 'skills\browser-control'
    if (Test-Path $skillDir) { Remove-Item $skillDir -Recurse -Force; Ok $skillDir }
    else { Info 'not present' }
}

Step 'Removing generated secrets'
foreach ($f in (Join-Path $Root '.bridge-token'), (Join-Path $Root 'extension\token.json')) {
    if (Test-Path $f) { Remove-Item $f -Force; Ok (Split-Path $f -Leaf) }
}

Write-Host @"

  Done. Two things are left for you:

    1.  chrome://extensions  ->  remove "Kiro Browser Bridge"
    2.  delete this folder if you no longer want it

"@ -ForegroundColor Gray
