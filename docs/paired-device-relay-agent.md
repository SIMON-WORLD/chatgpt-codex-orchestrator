# Stable Runtime paired-device relay-agent mode

Issue #181 adds an **opt-in, default-off** outbound relay-agent mode to the existing Stable Runtime. It does not replace the existing Local MCP or Secure Tunnel path and it does not change the runtime's default ChatGPT readiness semantics.

## Local device setup

The local human/operator may add a `relayAgent` block to the ordinary v0.2 runtime config:

```json
{
  "relayAgent": {
    "enabled": true,
    "relayUrl": "https://relay.example",
    "deviceId": "<paired stable deviceId>",
    "credentialEnv": "LOCAL_RELAY_DEVICE_SECRET"
  }
}
```

Store the paired device credential only in the referenced local environment variable:

```text
LOCAL_RELAY_DEVICE_SECRET=<one-device credential>
```

Do not put the raw device credential in the config file. `loadV02Config` rejects a raw `relayAgent.credential` field.

Optional local transport tuning is bounded by `pollHoldMs`, `reconnectInitialMs`, and `reconnectMaxMs`. The mode uses outbound HTTP(S) connect/poll/respond calls only and performs bounded reconnect/backoff.

## Runtime semantics

When enabled in a normal serving runtime:

- one `runtimeId` is generated for that Stable Runtime relay-agent instance;
- the agent authenticates with the configured `deviceId` plus the locally resolved device credential;
- each relay reconnect receives a new server `connectionEpoch` while retaining the same process-lifetime `runtimeId`;
- readiness reported to the relay comes only from the normal-serving local `/readyz` contract introduced by #177;
- shutdown aborts outstanding relay/readiness requests and reconnect delay before the local MCP server is closed;
- revoke or invalid device credentials fail closed instead of reconnecting forever.

The internal execution seam accepts only a private `tools/call` payload and delegates that call back into the existing loopback Local MCP server. The existing Local MCP remains the final authority for workspace binding, #176 filesystem scope, sensitive-path policy, mutation ownership, process rules, and any tool-specific authorization.

Issue #181 **by itself** did not add public ChatGPT MCP `list_devices`, `workspace_open(deviceId)`, or relay workspace/process handle affinity. Those ChatGPT-facing routing capabilities were added later by accepted #183 on top of this mode.

Current accepted state through #185:

- one account-facing Local Connector Relay can route to exact paired devices by stable opaque `deviceId`;
- account-facing device state includes Online / Last seen / executorReady / Ready, and revoke is enforced;
- Ready still derives from this mode's #177 normal-serving executor-aware readiness, not transport presence alone;
- relay-owned workspace/process handles add account + device + runtime affinity while remaining resource/context handles rather than Governance authority;
- same-runtime reconnect preserves handles; runtime restart or revoke invalidates stale handles; bound-device offline/non-ready never silently fails over;
- #176 `selected_roots` / `os_user_scope` remains device-local and cannot be widened by Relay;
- #185 real two-device dogfood proved the ChatGPT-facing relay path, including A/B read/process sentinels, affinity, reconnect continuity, runtime restart fencing, duplicate-name routing, revoke isolation and local filesystem denial.

This does **not** authorize a production relay deployment, final OAuth/OIDC binding, GUI/stdin control, Governance changes, default/release flip, or retirement of the canonical single-device Secure Tunnel path.
