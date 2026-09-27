import { loadV02Config } from '../config.js';

function normalizeUrl(value) { return String(value || '').replace(/\/+$/u, ''); }

async function jsonProbe(fetchImpl, url, options = {}) {
  if (!url) return { ok: false, status: 0, body: null, error: 'not_configured' };
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000), ...options });
    let body = null;
    try { body = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error?.name || 'probe_failed' };
  }
}

function revisionOf(probe) {
  const value = String(probe?.body?.revision || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(value) ? value : null;
}

function safeDevices(body) {
  const rows = Array.isArray(body?.devices) ? body.devices : [];
  return rows.map((row) => ({
    deviceId: row.deviceId || null,
    displayName: row.displayName || null,
    online: row.online === true,
    executorReady: row.executorReady === true,
    ready: row.ready === true,
    lastSeenAt: row.lastSeenAt ?? null,
    runtimeId: row.runtimeId || null,
  }));
}

export async function composePrivateRelayDoctor({
  configPath,
  expectedSha = null,
  relayUrl = null,
  accountBearer = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!configPath) throw new Error('configPath is required');
  const config = loadV02Config({}, { configPath });
  const localBase = 'http://' + config.host + ':' + config.port;
  const localHealth = await jsonProbe(fetchImpl, localBase + '/healthz');
  const localReady = await jsonProbe(fetchImpl, localBase + '/readyz');
  const tunnelStartupReady = config.tunnel?.healthUrl
    ? await jsonProbe(fetchImpl, config.tunnel.healthUrl)
    : { ok: null, status: 0, body: null, error: 'not_configured' };
  const controlPlanePolling = {
    state: 'unknown',
    observed: false,
    source: 'unobserved',
    reason: 'no_supported_polling_health_signal_configured',
  };

  const effectiveRelayUrl = normalizeUrl(relayUrl || config.relayAgent?.relayUrl);
  const relayDevices = effectiveRelayUrl && accountBearer
    ? await jsonProbe(fetchImpl, effectiveRelayUrl + '/devices', {
        headers: { authorization: 'Bearer ' + accountBearer },
      })
    : { ok: false, status: 0, body: null, error: effectiveRelayUrl ? 'account_bearer_missing' : 'not_configured' };

  const healthRevision = revisionOf(localHealth);
  const readyRevision = revisionOf(localReady);
  const activeRevision = healthRevision && healthRevision === readyRevision ? healthRevision : null;
  const expected = expectedSha ? String(expectedSha).toLowerCase() : null;
  const revisionMatches = expected ? activeRevision === expected : activeRevision !== null;
  const relayAlive = relayDevices.ok === true;
  const devices = safeDevices(relayDevices.body);
  const readyDevices = devices.filter((device) => device.ready);
  const relayAgentEnabled = config.relayAgent?.enabled === true;
  const configuredRelayDeviceId = relayAgentEnabled ? config.relayAgent.deviceId : null;
  const configuredRelayDevice = configuredRelayDeviceId
    ? devices.find((device) => device.deviceId === configuredRelayDeviceId) || null
    : null;
  const relayDeviceMatches = configuredRelayDeviceId
    ? configuredRelayDevice !== null
    : !relayAgentEnabled;
  const configuredRelayDeviceReady = relayAgentEnabled
    ? configuredRelayDevice?.ready === true
    : readyDevices.length > 0;
  const profileMatches = localHealth.ok === true
    && localReady.ok === true
    && (!config.tunnel?.healthUrl || tunnelStartupReady.ok === true)
    && relayDeviceMatches;

  let stopBoundary = null;
  if (!localHealth.ok || !localReady.ok) stopBoundary = 'stable_runtime';
  else if (tunnelStartupReady.ok === false && config.tunnel?.healthUrl) stopBoundary = 'secure_tunnel_startup_readiness';
  else if (!relayAlive) stopBoundary = 'relay';
  else if (!configuredRelayDeviceReady) stopBoundary = 'device_readiness';

  return {
    status: localHealth.ok && localReady.ok && revisionMatches && profileMatches && relayAlive && configuredRelayDeviceReady
      ? 'READY' : 'NOT_READY',
    configuration: {
      profileMatches,
      relayDeviceMatches,
      configuredRelayDeviceId,
      configuredRelayDeviceReady,
    },
    statusScope: 'local_profile_prerequisites',
    localRelay: { configured: Boolean(effectiveRelayUrl), alive: relayAlive, status: relayDevices.status || 0 },
    secureTunnel: {
      configured: Boolean(config.tunnel?.healthUrl),
      startupLocalReady: tunnelStartupReady.ok,
      status: tunnelStartupReady.status || 0,
      readinessScope: 'startup_local',
    },
    controlPlanePolling,
    chatgptDispatch: {
      state: 'unproven',
      proven: false,
      reason: 'passive_doctor_cannot_prove_next_chatgpt_dispatch',
    },
    stableRuntime: {
      health: localHealth.ok,
      ready: localReady.ok,
      revision: activeRevision,
      expectedRevision: expected,
      revisionMatches,
    },
    devices,
    stopBoundary,
  };
}

export function privateRelayDoctorExitCode(result) {
  return result?.status === 'READY' && result?.statusScope === 'local_profile_prerequisites' ? 0 : 2;
}
