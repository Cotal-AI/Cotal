# @cotal-ai/manager

The agent supervisor: a mesh endpoint that spawns and manages nodes via a pluggable `Runtime`
(`pty` built-in; `tmux` via `@cotal-ai/tmux`; `cmux` via `@cotal-ai/cmux`; `orca` via `@cotal-ai/orca`;
`herdr` via `@cotal-ai/herdr`), plus its own control-plane commands
(`start`/`stop`/`ps`/`attach`) and a WebSocket attach endpoint.

It owns process lifecycle and config, not the agents' work; agents still coordinate laterally
over the mesh.

**Tier:** `implementations/` (a self-contained surface over core). Implementations never import
each other; they meet at runtime over NATS.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Startup reconciliation

On an authenticated static mesh, the manager starts reconciling durable orphaned static slots,
then overlaps the remaining sweep with control-service registration. Startup logs each terminal as
`static reconcile k/N via <broker>: <alias> ...`; `cotal ps` becomes available before a slow sweep
completes. The no-race boundary is per alias: `spawn` for an alias still reconciling refuses until
that exact lifecycle terminal attempt returns; unrelated aliases and read-only control remain
available. A terminal error releases that alias fence so the sweep can continue, but leaves the
slot wedged until the next manager start re-drives it; `k/N` is sweep progress, not a count of
successful terminals.

## Maintenance API

The admin control operations `preparePreservation {attemptId}` and
`commitPreservation {attemptId}` form a crash-safe handshake. Prepare fences new lifecycle/control
work, waits for already accepted work, and returns a `cotal-manager-resume/v1` non-secret inventory
without stopping a child. The coordinator must fsync that inventory into its locked maintenance
attempt before commit hard-stops and authoritatively awaits managed children without deprovisioning.
A failed child stop returns `ok: false` with the inventory and per-agent failures; callers must not
publish a completed maintenance cut. `abortPreservation {attemptId}` returns an abandoned prepare to
active mode only before commit starts. Runtime providers must implement `AgentHandle.waitForExit()`;
otherwise commit fails closed instead of guessing that the child is gone.

Library composition roots can call `Manager.preserveState({ attemptId, persistInventory })` and later use
`Manager.resumePreserved()` on a fresh active manager. The complete inventory is preflighted before
the first child launches. Static and open entries reuse and validate the exact retained principal.
User-auth entries are validated internally through `resolveAuthProvider().validateRetainedAgent()`;
the manager never calls `grantAgent` or provisions a replacement identity. Ordinary
`Manager.stop()` remains destructive while the manager is active.

After restore, start the manager with `supervise --resume-attempt <id>`, wait for normal manager
readiness, then send the admin control request:

```json
{"op":"resumePreserved","args":{"attemptId":"<id>","inventory":{"version":"cotal-manager-resume/v1","space":"<space>","createdAt":"<iso>","agents":[]}}}
```

The request is limited to 512 KiB and parsed with strict nested schemas; unknown fields are rejected.
The reply carries the attempt id, `state: "awaitingCommit"`, and one result per inventory agent.
Activated agents remain cleanup-suppressed and ordinary lifecycle work stays fenced. `commitResume`
revalidates every exact retained handle, principal, presence entry, file, static credential, and user
authority row, then returns `state: "awaitingFinalize"` plus a `durableCommitToken`; it deliberately
does not release the fence or cleanup suppression. The coordinator must durably record that result
before echoing its token in the separate admin request:

```json
{"op":"finalizeResume","args":{"attemptId":"<id>","durableCommitToken":"<64 lowercase hex chars>"}}
```

Only token-bound finalization releases ordinary destructive lifecycle semantics. Both operations are
same-attempt idempotent. A manager signal or lease loss after commit but before finalization remains
retention-safe, while failed or partial activation cannot be committed or finalized.
