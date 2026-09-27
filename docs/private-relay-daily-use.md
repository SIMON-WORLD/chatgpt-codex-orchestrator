# Private Relay daily-use operability

This is the bounded single-user operating path for the already-accepted private Local Connector Relay topology. It does not add a service manager, scheduler, hosted auth product, retry engine, or release/default change.

## Canonical start / recover

Use the existing Issue #75 recovery coordinator as the only lifecycle authority:

```powershell
npm run recover:private-relay -- --config <stable-runtime-config> --sha <exact-40-hex-accepted-revision> --repo <trusted-canonical-repo>
```

`recover:private-relay` is intentionally an alias of `host/stable-runtime-recover.mjs`. Exact revision/profile/repo binding, single-listener checks, idempotent reuse, fail-closed drift handling, and externally managed Secure Tunnel ownership therefore remain unchanged. When `relayAgent.enabled=true`, the recovered Stable Runtime starts the existing relay-agent mode as part of the normal runtime. Do not add an independent Relay-agent supervisor.

Repeated recovery must reuse the one proven exact Stable Runtime listener. Unknown listeners, wrong revisions, binding drift, or missing Secure Tunnel startup/local readiness fail closed. This recovery proof does not establish current control-plane polling freshness or guarantee the next ChatGPT-facing dispatch. Do not broad-kill processes.

## Composed doctor / status

Keep the account bearer only in an environment variable:

```powershell
$env:PRIVATE_RELAY_ACCOUNT_BEARER = '<private bearer>'
npm run doctor:private-relay -- --config <stable-runtime-config> --sha <exact-40-hex-accepted-revision>
```

The doctor is read-only and composes existing surfaces only:
- local Stable Runtime `/healthz` + `/readyz`;
- configured external Secure Tunnel `/readyz` as startup/local readiness only;
- Relay account `/devices` state for Online / executorReady / Ready and runtimeId;
- control-plane polling as a separate observation. On the current profile, no explicitly supported bounded polling-health signal is configured, so it is reported as `unknown` / `unobserved` rather than inferred from `/readyz`.

For compatibility, top-level `status: "READY"` and CLI exit `0` mean only that `statusScope: "local_profile_prerequisites"` passed. They do not mean end-to-end ChatGPT dispatch is proven. `chatgptDispatch.state` remains `unproven` for this passive doctor even when all local/profile/device prerequisites are green. Exit `2` means those local/profile prerequisites are not ready; exit `1` is a doctor invocation/runtime error.

Output is metadata-only. It does not print bearer/device credentials, command bodies, file contents, tool results, or raw child output. `stopBoundary` identifies the first currently observable prerequisite boundary among `stable_runtime`, `secure_tunnel_startup_readiness`, `relay`, and `device_readiness`.

## Durable batch workload pattern

For Python/R/Stata-style non-interactive work, the supported pattern is:

```text
process_start once
→ ordinary local batch continues
→ workload writes deterministic status/result artifacts under its authorized workspace
→ later admitted Relay/ChatGPT call reads those artifacts with ordinary workspace read
```

The workload, not the conversation and not the Relay, owns the result contract. Use deterministic names such as `artifacts/status.json` and `artifacts/result.json`, preferably atomic temp-file + rename writes.

A lost conversation/tool turn does not imply rollback. Cancellation does not imply rollback. If dispatch outcome is ambiguous, do not blindly retry side effects: first reconcile the authoritative workspace artifacts and any current process/runtime state, then decide whether another dispatch is safe.

No scheduler, watcher, workflow engine, persistent REPL/stdin channel, or per-application wrapper is part of this pattern.

## Machine-level boundary

Real reboot/logon dogfood, sleep/wake, Task Scheduler/Startup-folder installation, and destructive network changes remain explicit Human-approval actions. The repository proof uses bounded process/network simulation only.
