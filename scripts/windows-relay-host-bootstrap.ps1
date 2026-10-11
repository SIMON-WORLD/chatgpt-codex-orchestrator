# chatgpt-codex-orchestrator#212/windows-relay-host-bootstrap/v1
param([switch]$Plan)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$NodeExe = 'D:\Software\nvm\nodejs\node.exe'
$ExpectedBootstrapPath = 'E:\Project\chatgpt-codex-orchestrator\issue-185-runtime\windows-login-autostart\windows-relay-host-bootstrap.ps1'
$RelayRepo = 'E:\Project\chatgpt-codex-orchestrator\chatgpt-codex-orchestrator-issue-185'
$RuntimeRoot = 'E:\Project\chatgpt-codex-orchestrator\issue-185-runtime'
$RelayRunner = 'E:\Project\chatgpt-codex-orchestrator\issue-185-runtime\relay-runner.mjs'
$RelayRunnerSha256 = 'ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1'
$TunnelExe = 'D:\Software\tunnel-client\tunnel-client-v0.0.14-windows-amd64\tunnel-client.exe'
$TunnelProfile = 'issue-185-relay'
$TunnelProfileDir = 'E:\Project\chatgpt-codex-orchestrator\issue-185-runtime\tunnel-profiles'
$TunnelProfilePath = 'E:\Project\chatgpt-codex-orchestrator\issue-185-runtime\tunnel-profiles\issue-185-relay.yaml'
$TunnelProfileSha256 = '303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3'
$StableConfig = 'E:\Project\chatgpt-codex-orchestrator\issue-185-runtime\device-a-config.json'
$StableConfigSha256 = '8092b6443dcd6c3b4409ae078cf3c483dc99ac1232d7aae25f1e53634deea148'
$RelayRepoSha = '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9'
$RuntimeSha = '628a2df906db9afcd8e80b7466f1667777e8cd69'
$RecoveryRepo = 'E:\Project\chatgpt-codex-orchestrator\windows-login-runtime'
$RecoveryRepoSha = 'f87f4665fa225e904f4edf0408181f52074e267e'
$Recovery = Join-Path $RecoveryRepo 'host\stable-runtime-recover.mjs'
$RecoverySha256 = '9ed8978d4075e782cb7c573bdb97fe426e11865a80250b10c183919317d08536'
$Doctor = Join-Path $RelayRepo 'scripts\private-relay-doctor.mjs'
$DoctorSha256 = '2ad32ee6e91d9a9728452a3fb8ee1156c8a24d0f3d29eade58a117df69676f65'
$RelayPorts = @(18745, 18746, 18747)
$TunnelPort = 18748
$McpRef = ('Author' + 'ization: env:ISSUE185_RELAY_AUTHORIZATION')
$CheckpointPath = Join-Path $RuntimeRoot 'windows-login-autostart\last-result.json'
$script:CheckpointArmed = $false
$script:FailurePhase = 'preflight'

# Task output may be unavailable after AtLogOn. Persist ONLY a fixed phase and
# result; never exceptions, arguments, header values, or environment variables.
function Write-SafeCheckpoint([string]$Status, [string]$Phase) {
  $allowed = @('preflight', 'relay_start', 'relay_ready', 'tunnel_start', 'tunnel_ready', 'runtime_recovery', 'doctor', 'complete')
  if ($Phase -notin $allowed) { $Phase = 'preflight' }
  $record = [ordered]@{
    schema = 'issue212-bootstrap-result-v1'
    status = $Status
    phase = $Phase
    runtimeSha = $RuntimeSha
    at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $json = ConvertTo-Json -InputObject $record -Compress -Depth 3
  $directory = Split-Path -Parent $CheckpointPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'checkpoint directory missing' }
  $temporary = Join-Path $directory 'last-result.tmp'
  [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $CheckpointPath -Force
}

trap {
  if ($script:CheckpointArmed -and -not $Plan) {
    try { Write-SafeCheckpoint 'FAIL' $script:FailurePhase } catch {}
  }
  Write-Output ('WINDOWS_RELAY_HOST_BOOTSTRAP FAIL phase=' + $script:FailurePhase)
  exit 1
}

function Assert-ExactFileHash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "required file missing: $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "file hash drift: $Path" }
}

function Get-UserSecret([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'User')
  if ([string]::IsNullOrWhiteSpace($value)) { throw "missing User-scope secret reference: $Name" }
  return $value
}

function Get-ExactListenerPids([int]$Port) {
  return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
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

function Assert-TunnelReady {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18748/readyz' -TimeoutSec 3
  if ($response.StatusCode -ne 200) { throw 'tunnel readiness failed' }
}


# A cold Windows login may bind the three Relay listeners on different ticks.
# Poll ONLY the exact spawned child. Foreign/ambiguous owners fail immediately;
# HTTP authorization must eventually prove 200 before advancing to Tunnel.
function Wait-ExactRelayStartup([int]$ExpectedPid, [int]$TimeoutMs = 15000) {
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    if ($null -eq (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) { throw 'relay spawned process exited before readiness' }
    $allBound = $true
    foreach ($port in $RelayPorts) {
      $owners = @(Get-ExactListenerPids $port)
      if ($owners.Count -gt 1 -or ($owners.Count -eq 1 -and $owners[0] -ne $ExpectedPid)) { throw 'relay listener owner drift during startup' }
      if ($owners.Count -ne 1) { $allBound = $false }
    }
    if ($allBound) {
      $ownerPid = Assert-RelayTopology
      if ($ownerPid -ne $ExpectedPid) { throw 'relay startup listener PID mismatch' }
      try { Assert-RelayAccessReady $relayRefValue; return $ownerPid } catch {}
    }
    Start-Sleep -Milliseconds 200
  } while ($elapsed.ElapsedMilliseconds -lt $TimeoutMs)
  throw 'relay exact startup readiness timeout'
}

# A tunnel listener alone is not sufficient: require its exact process/profile
# AND a successful /readyz, without retrying over a foreign or ambiguous PID.
function Wait-ExactTunnelStartup([int]$ExpectedPid, [int]$TimeoutMs = 15000) {
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    if ($null -eq (Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue)) { throw 'tunnel spawned process exited before readiness' }
    $owners = @(Get-ExactListenerPids $TunnelPort)
    if ($owners.Count -gt 1 -or ($owners.Count -eq 1 -and $owners[0] -ne $ExpectedPid)) { throw 'tunnel listener owner drift during startup' }
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

function Assert-RecoveryRepoRevision {
  $head = (& git -C $RecoveryRepo rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $head -ne $RecoveryRepoSha) { throw 'Recovery CLI repo revision drift' }
  $trackedDrift = @(& git -C $RecoveryRepo status --porcelain --untracked-files=no 2>$null)
  if ($LASTEXITCODE -ne 0 -or $trackedDrift.Count -ne 0) { throw 'Recovery CLI repo tracked files drift' }
}

$actualBootstrapPath = (Resolve-Path -LiteralPath $PSCommandPath).Path
if ($actualBootstrapPath.ToLowerInvariant() -ne $ExpectedBootstrapPath.ToLowerInvariant()) { throw 'bootstrap durable path drift' }
$script:CheckpointArmed = $true

Assert-ExactFileHash $RelayRunner $RelayRunnerSha256
Assert-ExactFileHash $TunnelProfilePath $TunnelProfileSha256
Assert-ExactFileHash $StableConfig $StableConfigSha256
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'exact Node executable missing' }
if (-not (Test-Path -LiteralPath $TunnelExe -PathType Leaf)) { throw 'exact tunnel-client executable missing' }
Assert-ExactFileHash $Recovery $RecoverySha256
Assert-ExactFileHash $Doctor $DoctorSha256
Assert-RelayRepoRevision
Assert-RecoveryRepoRevision

$relayRefValue = Get-UserSecret 'ISSUE185_RELAY_AUTHORIZATION'
if (-not $relayRefValue.StartsWith('Bearer ')) { throw 'ISSUE185_RELAY_AUTHORIZATION malformed' }
$deviceRefValue = Get-UserSecret 'LOCAL_RELAY_DEVICE_SECRET'
$controlRefValue = Get-UserSecret 'CONTROL_PLANE_API_KEY'

[Environment]::SetEnvironmentVariable('ISSUE185_RELAY_AUTHORIZATION', $relayRefValue, 'Process')
[Environment]::SetEnvironmentVariable('ISSUE185_REPO', $RelayRepo, 'Process')
[Environment]::SetEnvironmentVariable('ISSUE185_RUNTIME_ROOT', $RuntimeRoot, 'Process')
[Environment]::SetEnvironmentVariable('LOCAL_RELAY_DEVICE_SECRET', $deviceRefValue, 'Process')
[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $controlRefValue, 'Process')
[Environment]::SetEnvironmentVariable('MCP_EXTRA_HEADERS', $McpRef, 'Process')
[Environment]::SetEnvironmentVariable('MCP_DISCOVERY_EXTRA_HEADERS', $McpRef, 'Process')
[Environment]::SetEnvironmentVariable('PRIVATE_RELAY_ACCOUNT_BEARER', $relayRefValue.Substring('Bearer '.Length), 'Process')

$script:FailurePhase = 'relay_ready'
$relayPidValue = Assert-RelayTopology
$script:FailurePhase = 'tunnel_ready'
$tunnelPidValue = Assert-TunnelTopology

$planActions = @()
if ($null -eq $relayPidValue) { $planActions += 'start-relay-runner' } else {
  $script:FailurePhase = 'relay_ready'
  Assert-RelayAccessReady $relayRefValue
  $planActions += "reuse-relay-runner:$relayPidValue"
}
if ($null -eq $tunnelPidValue) { $planActions += 'start-secure-tunnel' } else {
  $script:FailurePhase = 'tunnel_ready'
  Assert-TunnelReady
  $planActions += "reuse-secure-tunnel:$tunnelPidValue"
}
$planActions += 'recover-stable-runtime'
$planActions += 'private-relay-doctor'

if ($Plan) {
  [pscustomobject]@{
    status = 'PLAN'
    relayPorts = $RelayPorts
    tunnelPort = $TunnelPort
    stablePort = 18749
    stableSha = $RuntimeSha
    runtimeSha = $RuntimeSha
    relayRepoSha = $RelayRepoSha
    actions = $planActions
    referenceSources = @('User:ISSUE185_RELAY_AUTHORIZATION', 'User:LOCAL_RELAY_DEVICE_SECRET', 'User:CONTROL_PLANE_API_KEY')
    mcpAuthContract = $McpRef
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ($null -eq $relayPidValue) {
  $script:FailurePhase = 'relay_start'
  $relayProcess = Start-Process -FilePath $NodeExe -ArgumentList @($RelayRunner) -WorkingDirectory $RelayRepo -WindowStyle Hidden -PassThru
  $script:FailurePhase = 'relay_ready'
  $relayPidValue = Wait-ExactRelayStartup $relayProcess.Id
}

if ($null -eq $tunnelPidValue) {
  $script:FailurePhase = 'tunnel_start'
  $tunnelProcess = Start-Process -FilePath $TunnelExe -ArgumentList @('run', '--profile', $TunnelProfile, '--profile-dir', $TunnelProfileDir) -WorkingDirectory (Split-Path -Parent $TunnelExe) -WindowStyle Hidden -PassThru
  $script:FailurePhase = 'tunnel_ready'
  $tunnelPidValue = Wait-ExactTunnelStartup $tunnelProcess.Id
}

$script:FailurePhase = 'runtime_recovery'
& $NodeExe $Recovery '--config' $StableConfig '--repo' $RelayRepo '--sha' $RuntimeSha
if ($LASTEXITCODE -ne 0) { throw 'canonical Stable Runtime recovery failed' }

$script:FailurePhase = 'doctor'
& $NodeExe $Doctor '--config' $StableConfig '--sha' $RuntimeSha '--account-bearer-env' 'PRIVATE_RELAY_ACCOUNT_BEARER'
if ($LASTEXITCODE -ne 0) { throw 'private-relay doctor failed' }

$script:FailurePhase = 'complete'
Write-SafeCheckpoint 'PASS' 'complete'
Write-Output 'WINDOWS_RELAY_HOST_BOOTSTRAP PASS'
exit 0
