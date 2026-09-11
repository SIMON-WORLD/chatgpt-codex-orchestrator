# Opt-in structured Codex diagnostics

Issue #64 adds one narrow `CHATGPT_DIRECT_LOCAL` capability for privacy-preserving Codex diagnostics outside normal mutable workspace roots.

## Enablement

The capability is disabled by default. Enable only the fixed Codex diagnostic surface in the v0.2 runtime config:

```json
{
  "diagnostics": {
    "codex": {
      "enabled": true
    }
  }
}
```

There is intentionally no diagnostic path/root setting. Enabling this flag does not add the Codex home to `workspaceRoots` and does not grant generic filesystem access.

## MCP contract

When enabled, the runtime registers `codex_diagnostics`. The caller may select only:

- `stall_summary`, with an optional integer `windowHours` from 1 to 168; or
- `config_safety`.

The tool accepts no `workspaceId`, filesystem path, command/argv, SQL, regex/search query, raw-output option, or mutation parameter. Unknown input fields fail closed.

The server resolves a fixed Codex diagnostic source set and returns only a fixed schema of status codes, booleans, bounded counters, and completeness fields. It never returns raw log rows, config text, stdout/stderr, prompts/messages, session/conversation/thread/turn identifiers, session-derived filenames, provider identifiers, absolute paths, URLs, named-pipe values, environment values, credentials, secrets, or arbitrary OS exception text.

## Read-only and containment boundary

The service rejects symbolic-link/junction source aliases and canonical-path escape, requires the expected regular-file type, opens the log database through Node SQLite read-only mode, and reads the fixed config source without mutation. The initial implementation performs no network/socket probe, subprocess execution, repair/tuning action, temp/cache write, package/process control, or Governance mutation.

This capability never acquires `MutationOwner` and does not change existing `workspaceRoots`, Direct Local read/search/verify semantics, routing, Governance, or Codex Delegate behavior.

## Non-goals

This is not a generic read-only root class, shell, arbitrary-path reader, diagnostic plugin registry, raw log/config browser, or permission/RBAC framework. Activating it on a real user machine and using it to diagnose an observed Codex stall are separate explicitly authorized dogfood steps; repository tests use only synthetic fixtures.
