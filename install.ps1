<#
.SYNOPSIS
    One-command setup for Kiro browser control. Run this on a new machine and
    everything except loading the Chrome extension is done for you.

.DESCRIPTION
    Does all of the following, idempotently - safe to re-run:

      1. Checks Python 3.8+ and installs the websockets package
      2. Generates a shared secret and embeds it in the extension so it
         self-pairs (no token pasting)
      3. Registers the MCP server in Kiro's user-level mcp.json
      4. Installs the browser-control skill into ~/.kiro/skills
      5. Creates a logon scheduled task so the bridge survives reboots
      6. Starts the bridge and verifies both ports are listening
      7. Runs the security test suite
      8. Prints the one manual step and copies the extension path to clipboard

    The only thing it cannot do is click "Load unpacked" in chrome://extensions.
    Chrome deliberately provides no API or command line for that.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    # Skip the scheduled task (run the bridge manually instead)
    .\install.ps1 -NoLogonTask

.EXAMPLE
    # Allow browser_eval - arbitrary JS in a logged-in browser. Off by default.
    .\install.ps1 -AllowEval
#>

[CmdletBinding()]
param(
    [switch]$NoLogonTask,
    [switch]$AllowEval,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$Root      = $PSScriptRoot
$TaskName  = 'KiroBrowserBridge'
$KiroHome  = Join-Path $env:USERPROFILE '.kiro'

function Step { param($m) Write-Host "`n=== $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "    [ok]   $m" -ForegroundColor Green }
function Info { param($m) Write-Host "           $m" -ForegroundColor Gray }
function Warn { param($m) Write-Host "    [warn] $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "    [fail] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  Kiro Browser Control - setup" -ForegroundColor White
Write-Host "  $Root" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
Step '1/8  Python'

$python = $null
foreach ($candidate in 'python', 'python3', 'py') {
    try {
        $v = & $candidate --version 2>&1
        if ($v -match 'Python (\d+)\.(\d+)') {
            if ([int]$Matches[1] -ge 3 -and [int]$Matches[2] -ge 8) {
                $python = (Get-Command $candidate).Source
                Ok "$v  ->  $python"
                break
            }
        }
    } catch { }
}
if (-not $python) {
    Fail 'Python 3.8+ not found on PATH.'
    Info 'Install from https://www.python.org/downloads/ and tick "Add to PATH".'
    throw 'Python is required.'
}

# ---------------------------------------------------------------------------
Step '2/8  Dependencies'

# pip writes advisory notices to stderr; with ErrorActionPreference=Stop that
# would abort the script. Verify by import instead of trusting the exit path.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $python -m pip install --quiet --upgrade websockets 2>&1 | Out-Null
$ErrorActionPreference = $prev

$wsVersion = & $python -c "import websockets; print(websockets.__version__)" 2>$null
if (-not $wsVersion) {
    Fail 'websockets did not install.'
    Info "Try manually:  $python -m pip install websockets"
    throw 'Missing dependency.'
}
Ok "websockets $wsVersion"

# ---------------------------------------------------------------------------
Step '3/8  Shared secret'

$token = & $python (Join-Path $Root 'scripts\bridge_server.py') --print-token
if (-not $token) { throw 'Token generation failed.' }
Ok 'token written to .bridge-token'

# Embedding the token in the extension folder is what removes the manual paste.
# It is not exposed via web_accessible_resources, so no web page can read it,
# and any local process able to read it could read .bridge-token anyway.
@{ token = $token } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $Root 'extension\token.json') -Encoding UTF8
Ok 'embedded in extension\token.json - the extension self-pairs'

# ---------------------------------------------------------------------------
Step '4/8  Kiro MCP registration'

$mcpDir  = Join-Path $KiroHome 'settings'
$mcpPath = Join-Path $mcpDir 'mcp.json'
New-Item -ItemType Directory -Force -Path $mcpDir | Out-Null

if (Test-Path $mcpPath) {
    Copy-Item $mcpPath "$mcpPath.bak" -Force
    try   { $cfg = Get-Content -Raw -LiteralPath $mcpPath | ConvertFrom-Json }
    catch { Warn 'existing mcp.json was not valid JSON - starting fresh (backup kept)'
            $cfg = [pscustomobject]@{} }
    Info 'existing config backed up to mcp.json.bak'
} else {
    $cfg = [pscustomobject]@{}
}
if (-not $cfg.PSObject.Properties.Name.Contains('mcpServers')) {
    $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
}

$entry = [pscustomobject]@{
    command  = $python
    args     = @((Join-Path $Root 'scripts\mcp_server.py'))
    disabled = $false
}
$cfg.mcpServers | Add-Member -NotePropertyName 'browser-bridge' -NotePropertyValue $entry -Force
$cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mcpPath -Encoding UTF8
Ok "registered 'browser-bridge' in $mcpPath"

# ---------------------------------------------------------------------------
Step '5/8  Kiro skill'

$skillSrc = Join-Path $Root 'kiro\skills\browser-control\SKILL.md'
$skillDir = Join-Path $KiroHome 'skills\browser-control'
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
Copy-Item $skillSrc (Join-Path $skillDir 'SKILL.md') -Force
Ok "installed to $skillDir"
Info 'appears as /browser-control in NEW chat sessions'

# A steering file with inclusion:manual would clash; remove the old one if the
# earlier hand-rolled setup left it behind.
$stale = Join-Path $KiroHome 'steering\browser-control.md'
if (Test-Path $stale) { Remove-Item $stale -Force; Info 'removed stale steering\browser-control.md' }

# ---------------------------------------------------------------------------
Step '6/8  Logon task'

if ($NoLogonTask) {
    Info 'skipped (-NoLogonTask). Start the bridge yourself when needed.'
}
else {
    $evalFlag = if ($AllowEval) { ' --allow-eval' } else { '' }
    $argLine  = '"{0}" --server{1}' -f (Join-Path $Root 'scripts\bridge_server.py'), $evalFlag

    $action = New-ScheduledTaskAction -Execute $python -Argument $argLine -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                    -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
                    -RestartInterval ([TimeSpan]::FromMinutes(1)) -MultipleInstances IgnoreNew

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Starts the Kiro browser bridge (WebSocket 8766 / HTTP 8765) at logon.' | Out-Null
    Ok "scheduled task '$TaskName' registered (at logon)"
}

# ---------------------------------------------------------------------------
Step '7/8  Start the bridge'

$running = $false
foreach ($p in 8765, 8766) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $p); $running = $true } catch { } finally { $c.Close() }
}

if ($running) {
    Info 'already listening - restarting to pick up any config change'
    Get-CimInstance Win32_Process -Filter "Name like '%python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*bridge_server.py*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

if ($NoLogonTask) {
    $evalFlag = if ($AllowEval) { '--allow-eval' } else { '' }
    Start-Process -FilePath $python `
        -ArgumentList @("`"$(Join-Path $Root 'scripts\bridge_server.py')`"", '--server', $evalFlag) `
        -WorkingDirectory $Root
} else {
    Start-ScheduledTask -TaskName $TaskName
}

$listening = @()
for ($i = 0; $i -lt 20 -and $listening.Count -lt 2; $i++) {
    Start-Sleep -Milliseconds 500
    $listening = @()
    foreach ($p in 8765, 8766) {
        $c = New-Object Net.Sockets.TcpClient
        try { $c.Connect('127.0.0.1', $p); $listening += $p } catch { } finally { $c.Close() }
    }
}
if ($listening.Count -eq 2) { Ok 'listening on 127.0.0.1:8765 (HTTP) and :8766 (WebSocket)' }
else { Warn "only these ports came up: $($listening -join ', ')" }

if ($AllowEval) { Warn 'browser_eval is ENABLED - arbitrary JS in a logged-in browser' }
else            { Info 'browser_eval disabled (default)' }

# ---------------------------------------------------------------------------
Step '8/8  Security tests'

if ($SkipTests) {
    Info 'skipped (-SkipTests)'
} else {
    $out = & $python (Join-Path $Root 'scripts\test_security.py') 2>&1
    $passLine = $out | Where-Object { $_ -match '(\d+)/(\d+) checks passed' } | Select-Object -First 1
    if ($passLine -match '(\d+)/(\d+)') {
        if ($Matches[1] -eq $Matches[2]) { Ok "$($Matches[0]) checks passed" }
        else {
            Fail "$($Matches[0]) checks passed - DO NOT USE against a browser with sessions you care about"
            $out | ForEach-Object { Info $_ }
        }
    } else {
        Warn 'could not parse test output:'
        $out | Select-Object -First 12 | ForEach-Object { Info $_ }
    }
}

# ---------------------------------------------------------------------------
$extPath = Join-Path $Root 'extension'
try { Set-Clipboard -Value $extPath; $clip = ' (copied to clipboard)' } catch { $clip = '' }

Write-Host ""
Write-Host ("=" * 72) -ForegroundColor Cyan
Write-Host "  ONE manual step left" -ForegroundColor Cyan
Write-Host ("=" * 72) -ForegroundColor Cyan
Write-Host @"

  Chrome cannot be told to load an unpacked extension from the command line,
  so this part is yours:

    1.  Open           chrome://extensions
    2.  Turn on        Developer mode      (top right)
    3.  Click          Load unpacked
    4.  Select         $extPath$clip

  Then start a NEW Kiro chat session and the browser_* tools will work.
  The extension reads token.json and pairs itself - nothing to paste.

  Verify:   ask Kiro "what tabs do I have open?"

"@ -ForegroundColor Gray

Write-Host "  Useful commands" -ForegroundColor White
Write-Host @"
    Restart bridge     Start-ScheduledTask -TaskName $TaskName
    Check ports        Test-NetConnection 127.0.0.1 -Port 8766
    Re-run tests       $python scripts\test_security.py
    Uninstall          .\uninstall.ps1

"@ -ForegroundColor DarkGray
