# Desktop Commander composite POC (Issue #117)

## Pinned upstream

- Package: `@wonderwhy-er/desktop-commander@0.2.51`
- Upstream commit: `092ce0b841e86455f12e41f4dc36399a7522ecb5`
- License: MIT; retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
- Child entrypoint: package `dist/index.js`, launched directly with the current Node executable; `npx` is not used.

The parent performs the MCP initialize and `listTools` handshake and fails closed
unless the required read/search/process tool set is present:
`read_file`, `start_search`, `get_more_search_results`, `stop_search`,
`start_process`, `read_process_output`, and `force_terminate`.

## Privacy and persistence

The child is a stdio subprocess. Workspace authorization, canonical containment,
sensitive-path checks, and the read binary probe happen in the parent before a
read/search/git adapter dispatches. The parent exposes no public shell tool;
`start_process` is reachable only through fixed internal git command templates.

The child receives the normal process environment, plus the upstream-supported
`DESKTOP_COMMANDER_DISABLE_TELEMETRY=1` environment override. Onboarding is
disabled with the upstream-supported `--no-onboarding` flag. The POC does not
mutate the user's persisted Desktop Commander configuration. Any upstream local
configuration/tool-history persistence that remains outside those two supported
launch controls is a narrowly documented privacy residual for this POC. No parent-side credential or child
process detail is included in the sanitized health object, which is exactly
`{ state, version, generation }`.

## Deletion candidates after parity validation

These are deliberately retained for rollback and existing callers during the
POC:

1. Legacy direct execution in `src/local/read.js` after all callers use the child adapter.
2. Legacy direct execution in `src/local/search.js` after all callers use the child adapter.
3. The direct `gitCmd` subprocess helper in `src/local/git.js`.
4. Duplicate commodity-engine coverage in `test/local/read.test.js`,
   `test/local/search.test.js`, and `test/local/git.test.js` once equivalent
   child-backed contract coverage is authoritative.
5. Compatibility convenience methods on `DesktopCommanderChild` once all
   adapters use one normalized internal call path.

The existing `ChangeSetService`/`OperationState` edit engine is not a deletion
candidate in this phase because Phase 4 stopped at the bounded edit boundary.

## Edit verdict

`COMPOSITE_EDIT_BOUNDARY_BLOCKED` is the exported verdict for a hypothetical
child-backed edit. Desktop Commander is not delegated an edit because doing so
would require threading the existing mutation owner, change-set, and operation
state lifecycle through the child boundary. The current edit engine remains
unchanged and authoritative.
