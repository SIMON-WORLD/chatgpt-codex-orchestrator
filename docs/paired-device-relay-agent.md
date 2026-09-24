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

This mode does **not** add public ChatGPT MCP `list_devices`, `workspace_open(deviceId)`, relay workspace/process handle affinity, a production relay deployment, GUI/stdin control, Governance changes, or a default/release flip.
