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
$StableSha = '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9'
$Recovery = Join-Path $RelayRepo 'host\stable-runtime-recover.mjs'
$RecoverySha256 = 'f6f7d17fb4e6908eb6e34cbee60811eee3f436ae9a4aae6269a18f74976a2694'
$Doctor = Join-Path $RelayRepo 'scripts\private-relay-doctor.mjs'
$DoctorSha256 = '2ad32ee6e91d9a9728452a3fb8ee1156c8a24d0f3d29eade58a117df69676f65'
$RelayPorts = @(18745, 18746, 18747)
$TunnelPort = 18748
$McpRef = ('Author' + 'ization: env:ISSUE185_RELAY_AUTHORIZATION')

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
  $allAbsent = ($sets | Where-Object { $_.Count -ne 0 }).Count -eq 0
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

function Assert-RelayRepoRevision {
  $head = (& git -C $RelayRepo rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $head -ne $StableSha) { throw 'Relay repo revision drift' }
  $trackedDrift = @(& git -C $RelayRepo status --porcelain --untracked-files=no 2>$null)
  if ($LASTEXITCODE -ne 0 -or $trackedDrift.Count -ne 0) { throw 'Relay repo tracked files drift' }
}

$actualBootstrapPath = (Resolve-Path -LiteralPath $PSCommandPath).Path
if ($actualBootstrapPath.ToLowerInvariant() -ne $ExpectedBootstrapPath.ToLowerInvariant()) { throw 'bootstrap durable path drift' }

Assert-ExactFileHash $RelayRunner $RelayRunnerSha256
Assert-ExactFileHash $TunnelProfilePath $TunnelProfileSha256
Assert-ExactFileHash $StableConfig $StableConfigSha256
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'exact Node executable missing' }
if (-not (Test-Path -LiteralPath $TunnelExe -PathType Leaf)) { throw 'exact tunnel-client executable missing' }
Assert-ExactFileHash $Recovery $RecoverySha256
Assert-ExactFileHash $Doctor $DoctorSha256
Assert-RelayRepoRevision

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

$relayPidValue = Assert-RelayTopology
$tunnelPidValue = Assert-TunnelTopology

$planActions = @()
if ($null -eq $relayPidValue) { $planActions += 'start-relay-runner' } else { Assert-RelayAccessReady $relayRefValue; $planActions += "reuse-relay-runner:$relayPidValue" }
if ($null -eq $tunnelPidValue) { $planActions += 'start-secure-tunnel' } else { Assert-TunnelReady; $planActions += "reuse-secure-tunnel:$tunnelPidValue" }
$planActions += 'recover-stable-runtime'
$planActions += 'private-relay-doctor'

if ($Plan) {
  [pscustomobject]@{
    status = 'PLAN'
    relayPorts = $RelayPorts
    tunnelPort = $TunnelPort
    stablePort = 18749
    stableSha = $StableSha
    actions = $planActions
    referenceSources = @('User:ISSUE185_RELAY_AUTHORIZATION', 'User:LOCAL_RELAY_DEVICE_SECRET', 'User:CONTROL_PLANE_API_KEY')
    mcpAuthContract = $McpRef
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ($null -eq $relayPidValue) {
  $relayProcess = Start-Process -FilePath $NodeExe -ArgumentList @($RelayRunner) -WorkingDirectory $RelayRepo -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 750
  $relayPidValue = Assert-RelayTopology
  if ($null -eq $relayPidValue -or $relayPidValue -ne $relayProcess.Id) { throw 'relay startup did not own exact listeners' }
  Assert-RelayAccessReady $relayRefValue
}

if ($null -eq $tunnelPidValue) {
  $tunnelProcess = Start-Process -FilePath $TunnelExe -ArgumentList @('run', '--profile', $TunnelProfile, '--profile-dir', $TunnelProfileDir) -WorkingDirectory (Split-Path -Parent $TunnelExe) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 1000
  $tunnelPidValue = Assert-TunnelTopology
  if ($null -eq $tunnelPidValue -or $tunnelPidValue -ne $tunnelProcess.Id) { throw 'tunnel startup did not own exact readiness listener' }
  Assert-TunnelReady
}

& $NodeExe $Recovery '--config' $StableConfig '--repo' $RelayRepo '--sha' $StableSha
if ($LASTEXITCODE -ne 0) { throw 'canonical Stable Runtime recovery failed' }

& $NodeExe $Doctor '--config' $StableConfig '--sha' $StableSha '--account-bearer-env' 'PRIVATE_RELAY_ACCOUNT_BEARER'
if ($LASTEXITCODE -ne 0) { throw 'private-relay doctor failed' }

Write-Output 'WINDOWS_RELAY_HOST_BOOTSTRAP PASS'
