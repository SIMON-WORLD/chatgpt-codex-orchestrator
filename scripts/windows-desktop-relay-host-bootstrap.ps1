param([switch]$Plan)

# chatgpt-codex-orchestrator#222/desktop-relay-host-bootstrap/v1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RuntimeRoot = 'E:\Project\chatgpt-codex-orchestrator\issue-222-relay-runtime'
$ExpectedBootstrapPath = Join-Path $RuntimeRoot 'windows-login\desktop-relay-host-bootstrap.ps1'
$RelayRepo = 'E:\Project\chatgpt-codex-orchestrator\chatgpt-codex-orchestrator-issue-185'
$RelayRepoSha = '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$RelayRunner = Join-Path $RuntimeRoot 'relay-runner.mjs'
$RelayRunnerSha256 = 'ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1'
$RelayDb = Join-Path $RuntimeRoot 'relay.sqlite'
$TunnelExe = Join-Path $RuntimeRoot 'bin\tunnel-client.exe'
$TunnelExeSha256 = 'fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b'
$TunnelProfileDir = Join-Path $RuntimeRoot 'tunnel-profiles'
$TunnelProfile = 'issue-185-relay'
$TunnelProfilePath = Join-Path $TunnelProfileDir 'issue-185-relay.yaml'
$TunnelProfileSha256 = '303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3'
$RelayPorts = @(18745, 18746, 18747)
$TunnelPort = 18748
$TailscaleExe = 'C:\\Program Files\\Tailscale\\tailscale.exe'
$TailscaleServeHost = 'desktop-2.tail4d2a66.ts.net:443'
$TailscaleServeTarget = 'http://127.0.0.1:18747'
$McpRef = ('Author' + 'ization: env:ISSUE185_RELAY_AUTHORIZATION')
$CheckpointPath = Join-Path $RuntimeRoot 'windows-login\last-result.json'
$script:CheckpointArmed = -not $Plan
$script:FailurePhase = 'preflight'

function Write-SafeCheckpoint([string]$Status, [string]$Phase) {
  $allowed = @('preflight', 'relay_start', 'relay_ready', 'tunnel_start', 'tunnel_ready', 'serve_ready', 'complete')
  if ($Phase -notin $allowed) { $Phase = 'preflight' }
  $record = [ordered]@{
    schema = 'issue222-desktop-relay-result-v1'
    status = $Status
    phase = $Phase
    at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $directory = Split-Path -Parent $CheckpointPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'checkpoint directory missing' }
  $temporary = Join-Path $directory 'last-result.tmp'
  [System.IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $record -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $CheckpointPath -Force
}

trap {
  if ($script:CheckpointArmed) {
    try { Write-SafeCheckpoint 'FAIL' $script:FailurePhase } catch {}
  }
  Write-Output ('WINDOWS_DESKTOP_RELAY_HOST_BOOTSTRAP FAIL phase=' + $script:FailurePhase)
  exit 1
}

function Assert-ExactFileHash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "required file missing: $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "file hash drift: $Path" }
}

function Get-UserReferencePresent([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'User')
  return -not [string]::IsNullOrWhiteSpace($value)
}

function Get-UserRef([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'User')
  if ([string]::IsNullOrWhiteSpace($value)) { throw "missing User-scope reference: $Name" }
  return $value
}

function Get-ExactListenerPids([int]$Port) {
  return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-ProcessRecord([int]$ProcessId) {
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
}

function Normalize-CommandLine([string]$Value) {
  return (($Value -replace '"', '') -replace '\s+', ' ').Trim().ToLowerInvariant()
}

function Assert-ExactProcess([int]$ProcessId, [string]$Exe, [string[]]$ExpectedArgs, [string]$Label) {
  $proc = Get-ProcessRecord $ProcessId
  if ($null -eq $proc) { throw "$Label process disappeared" }
  if ($proc.ExecutablePath.ToLowerInvariant() -ne $Exe.ToLowerInvariant()) { throw "$Label executable path drift" }
  $expected = Normalize-CommandLine ($Exe + ' ' + ($ExpectedArgs -join ' '))
  $actual = Normalize-CommandLine $proc.CommandLine
  if ($actual -ne $expected) { throw "$Label command/profile/path drift" }
}

function Assert-RelayTopology {
  $sets = @()
  foreach ($port in $RelayPorts) { $sets += ,@(Get-ExactListenerPids $port) }
  $allAbsent = @($sets | Where-Object { $_.Count -ne 0 }).Count -eq 0
  if ($allAbsent) { return $null }
  foreach ($set in $sets) { if ($set.Count -ne 1) { throw 'relay listener topology drift' } }
  $ownerPid = $sets[0][0]
  foreach ($set in $sets) { if ($set[0] -ne $ownerPid) { throw 'relay ports are not owned by one exact process' } }
  Assert-ExactProcess $ownerPid $NodeExe @($RelayRunner) 'relay'
  return $ownerPid
}

function Assert-TunnelTopology {
  $pids = @(Get-ExactListenerPids $TunnelPort)
  if ($pids.Count -eq 0) { return $null }
  if ($pids.Count -ne 1) { throw 'tunnel listener topology drift' }
  $ownerPid = $pids[0]
  Assert-ExactProcess $ownerPid $TunnelExe @('run', '--profile', $TunnelProfile, '--profile-dir', $TunnelProfileDir) 'tunnel'
  return $ownerPid
}

function Assert-RelayAccessReady([string]$Value) {
  $meta = @{}
  $meta[('Author' + 'ization')] = $Value
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18746/devices' -Headers $meta -TimeoutSec 3
  if ($response.StatusCode -ne 200) { throw 'relay access readiness probe failed' }
}

function Get-TailscaleServeState {
  if (-not (Test-Path -LiteralPath $TailscaleExe -PathType Leaf)) { throw 'exact Tailscale executable missing' }
  $raw = ((& $TailscaleExe serve status --json 2>$null | Out-String).Trim())
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { throw 'Tailscale Serve status unavailable' }
  try { $status = $raw | ConvertFrom-Json }
  catch { throw 'Tailscale Serve status JSON invalid' }

  $webProperty = $status.PSObject.Properties['Web']
  $tcpProperty = $status.PSObject.Properties['TCP']
  if ($null -eq $webProperty -and $null -eq $tcpProperty) { return 'absent' }
  if ($null -eq $webProperty -or $null -eq $tcpProperty) { return 'drift' }

  $webNames = @($webProperty.Value.PSObject.Properties.Name)
  $tcpNames = @($tcpProperty.Value.PSObject.Properties.Name)
  if ($webNames.Count -ne 1 -or $webNames[0] -ne $TailscaleServeHost) { return 'drift' }
  if ($tcpNames.Count -ne 1 -or $tcpNames[0] -ne '443') { return 'drift' }

  $hostConfig = $webProperty.Value.PSObject.Properties[$TailscaleServeHost].Value
  $handlerProperty = $hostConfig.PSObject.Properties['Handlers']
  if ($null -eq $handlerProperty) { return 'drift' }
  $handlerNames = @($handlerProperty.Value.PSObject.Properties.Name)
  if ($handlerNames.Count -ne 1 -or $handlerNames[0] -ne '/') { return 'drift' }
  $rootHandler = $handlerProperty.Value.PSObject.Properties['/'].Value
  $proxyProperty = $rootHandler.PSObject.Properties['Proxy']
  if ($null -eq $proxyProperty -or [string]$proxyProperty.Value -ne $TailscaleServeTarget) { return 'drift' }

  $tcpConfig = $tcpProperty.Value.PSObject.Properties['443'].Value
  $httpsProperty = $tcpConfig.PSObject.Properties['HTTPS']
  if ($null -eq $httpsProperty -or $httpsProperty.Value -ne $true) { return 'drift' }

  $funnelProperty = $status.PSObject.Properties['AllowFunnel']
  if ($null -ne $funnelProperty -and @($funnelProperty.Value.PSObject.Properties.Name).Count -ne 0) { return 'drift' }
  return 'exact'
}

function Ensure-ExactTailscaleServe([int]$TimeoutMs = 30000) {
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $state = $null
    try { $state = Get-TailscaleServeState } catch {}
    if ($state -eq 'exact') { return }
    if ($state -eq 'drift') { throw 'existing Tailscale Serve configuration differs from reviewed Relay ingress' }
    if ($state -eq 'absent') {
      & $TailscaleExe serve --bg --yes $TailscaleServeTarget | Out-Null
      if ($LASTEXITCODE -ne 0) { Start-Sleep -Milliseconds 500; continue }
    }
    Start-Sleep -Milliseconds 500
  } while ($elapsed.ElapsedMilliseconds -lt $TimeoutMs)
  throw 'Tailscale Serve exact ingress readiness timeout'
}

function Assert-TunnelReady {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18748/readyz' -TimeoutSec 3
  if ($response.StatusCode -ne 200) { throw 'tunnel readiness failed' }
}

function Wait-ExactRelayStartup([int]$ExpectedPid, [string]$AuthValue, [int]$TimeoutMs = 15000) {
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    if ($null -eq (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) {
      throw 'relay spawned process exited before readiness'
    }
    $allBound = $true
    foreach ($port in $RelayPorts) {
      $owners = @(Get-ExactListenerPids $port)
      if ($owners.Count -gt 1 -or ($owners.Count -eq 1 -and $owners[0] -ne $ExpectedPid)) {
        throw 'relay listener owner drift during startup'
      }
      if ($owners.Count -ne 1) { $allBound = $false }
    }
    if ($allBound) {
      $ownerPid = Assert-RelayTopology
      if ($ownerPid -ne $ExpectedPid) { throw 'relay startup listener PID mismatch' }
      try { Assert-RelayAccessReady $AuthValue; return $ownerPid } catch {}
    }
    Start-Sleep -Milliseconds 200
  } while ($elapsed.ElapsedMilliseconds -lt $TimeoutMs)
  throw 'relay exact startup readiness timeout'
}

function Wait-ExactTunnelStartup([int]$ExpectedPid, [int]$TimeoutMs = 15000) {
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    if ($null -eq (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) {
      throw 'tunnel spawned process exited before readiness'
    }
    $owners = @(Get-ExactListenerPids $TunnelPort)
    if ($owners.Count -gt 1 -or ($owners.Count -eq 1 -and $owners[0] -ne $ExpectedPid)) {
      throw 'tunnel listener owner drift during startup'
    }
    if ($owners.Count -eq 1) {
      $ownerPid = Assert-TunnelTopology
      if ($ownerPid -ne $ExpectedPid) { throw 'tunnel startup listener PID mismatch' }
      try { Assert-TunnelReady; return $ownerPid } catch {}
    }
    Start-Sleep -Milliseconds 200
  } while ($elapsed.ElapsedMilliseconds -lt $TimeoutMs)
  throw 'tunnel exact startup readiness timeout'
}

function Assert-RelayRepoRevision {
  $head = (& git -C $RelayRepo rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $head -ne $RelayRepoSha) { throw 'Relay repo revision drift' }
  $trackedDrift = @(& git -C $RelayRepo status --porcelain --untracked-files=no 2>$null)
  if ($LASTEXITCODE -ne 0 -or $trackedDrift.Count -ne 0) { throw 'Relay repo tracked files drift' }
}

$actualBootstrapPath = (Resolve-Path -LiteralPath $PSCommandPath).Path
if (-not $Plan -and $actualBootstrapPath.ToLowerInvariant() -ne $ExpectedBootstrapPath.ToLowerInvariant()) {
  throw 'bootstrap durable path drift'
}

Assert-ExactFileHash $RelayRunner $RelayRunnerSha256
Assert-ExactFileHash $TunnelExe $TunnelExeSha256
Assert-ExactFileHash $TunnelProfilePath $TunnelProfileSha256
if (-not (Test-Path -LiteralPath $RelayDb -PathType Leaf)) { throw 'consistent Relay SQLite main database is not staged' }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'exact Node executable missing' }
if (-not (Test-Path -LiteralPath $TailscaleExe -PathType Leaf)) { throw 'exact Tailscale executable missing' }
Assert-RelayRepoRevision

$requiredReferences = @('ISSUE185_RELAY_AUTHORIZATION', 'CONTROL_PLANE_API_KEY')
$missingReferences = @($requiredReferences | Where-Object { -not (Get-UserReferencePresent $_) })

$script:FailurePhase = 'relay_ready'
$relayPidValue = Assert-RelayTopology
$script:FailurePhase = 'tunnel_ready'
$tunnelPidValue = Assert-TunnelTopology

$planActions = @()
if ($null -eq $relayPidValue) { $planActions += 'start-relay-runner' }
else { $planActions += "reuse-relay-runner:$relayPidValue" }
if ($null -eq $tunnelPidValue) { $planActions += 'start-secure-tunnel' }
else {
  Assert-TunnelReady
  $planActions += "reuse-secure-tunnel:$tunnelPidValue"
}
$serveState = Get-TailscaleServeState
if ($serveState -eq 'absent') { $planActions += 'restore-exact-tailscale-serve' }
elseif ($serveState -eq 'exact') { $planActions += 'reuse-exact-tailscale-serve' }
else { throw 'existing Tailscale Serve configuration differs from reviewed Relay ingress' }

if ($Plan) {
  [pscustomobject]@{
    status = if ($missingReferences.Count -eq 0) { 'PLAN' } else { 'BLOCKED' }
    relayPorts = $RelayPorts
    tunnelPort = $TunnelPort
    tailscaleServeHost = $TailscaleServeHost
    tailscaleServeTarget = $TailscaleServeTarget
    excludedDeviceRuntimePort = 18749
    actions = $planActions
    missingUserReferences = $missingReferences
    referenceSources = @(
      'User:ISSUE185_RELAY_AUTHORIZATION',
      'User:CONTROL_PLANE_API_KEY'
    )
    relayRunnerSha256 = $RelayRunnerSha256
    tunnelClientSha256 = $TunnelExeSha256
    tunnelProfileSha256 = $TunnelProfileSha256
    relayRepoSha = $RelayRepoSha
  } | ConvertTo-Json -Depth 4
  exit $(if ($missingReferences.Count -eq 0) { 0 } else { 2 })
}

if ($missingReferences.Count -ne 0) { throw 'required User-scope reference missing' }

$relayRefValue = Get-UserRef 'ISSUE185_RELAY_AUTHORIZATION'
if (-not $relayRefValue.StartsWith('Bearer ')) { throw 'Relay authorization reference malformed' }
$controlRefValue = Get-UserRef 'CONTROL_PLANE_API_KEY'

[Environment]::SetEnvironmentVariable('ISSUE185_RELAY_AUTHORIZATION', $relayRefValue, 'Process')
[Environment]::SetEnvironmentVariable('ISSUE185_REPO', $RelayRepo, 'Process')
[Environment]::SetEnvironmentVariable('ISSUE185_RUNTIME_ROOT', $RuntimeRoot, 'Process')
[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $controlRefValue, 'Process')
[Environment]::SetEnvironmentVariable('MCP_EXTRA_HEADERS', $McpRef, 'Process')
[Environment]::SetEnvironmentVariable('MCP_DISCOVERY_EXTRA_HEADERS', $McpRef, 'Process')

if ($null -eq $relayPidValue) {
  $script:FailurePhase = 'relay_start'
  $relayProcess = Start-Process -FilePath $NodeExe -ArgumentList @($RelayRunner) -WorkingDirectory $RelayRepo -WindowStyle Hidden -PassThru
  $script:FailurePhase = 'relay_ready'
  $relayPidValue = Wait-ExactRelayStartup $relayProcess.Id $relayRefValue
} else {
  $script:FailurePhase = 'relay_ready'
  Assert-RelayAccessReady $relayRefValue
}

if ($null -eq $tunnelPidValue) {
  $script:FailurePhase = 'tunnel_start'
  $tunnelProcess = Start-Process -FilePath $TunnelExe -ArgumentList @('run', '--profile', $TunnelProfile, '--profile-dir', $TunnelProfileDir) -WorkingDirectory (Split-Path -Parent $TunnelExe) -WindowStyle Hidden -PassThru
  $script:FailurePhase = 'tunnel_ready'
  $tunnelPidValue = Wait-ExactTunnelStartup $tunnelProcess.Id
} else {
  $script:FailurePhase = 'tunnel_ready'
  Assert-TunnelReady
}

$script:FailurePhase = 'serve_ready'
Ensure-ExactTailscaleServe

$script:FailurePhase = 'complete'
Write-SafeCheckpoint 'PASS' 'complete'
Write-Output 'WINDOWS_DESKTOP_RELAY_HOST_BOOTSTRAP PASS'
exit 0
