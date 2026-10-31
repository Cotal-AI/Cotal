# @cotal-ai/manager

The agent supervisor: a mesh endpoint that spawns and manages nodes via a pluggable `Runtime`
(`pty` built-in; `tmux` via `@cotal-ai/tmux`; `cmux` via `@cotal-ai/cmux`; `orca` via `@cotal-ai/orca`;
`herdr` via `@cotal-ai/herdr`), plus its own control-plane commands
(`spawn --detach`/`stop`/`ps`/`attach`, where attach streams over a mesh session) and a
credentialed local HTTP console.

It owns process lifecycle and config, not the agents' work; agents still coordinate laterally
over the mesh.

**Tier:** `implementations/` (a self-contained surface over core). Implementations never import
each other; they meet at runtime over NATS.

See [docs/architecture.md](../../docs/architecture.md) (*Manager supervision*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Load measurements

`pnpm smoke:manager-seat-load --shape dist --seat real --process-memory --steps 10,25,50`
measures the real connector MCP processes on Linux. Build the CLI closure first and use a short,
private `TMPDIR` for the per-seat Unix sockets. These processes exclude the model harness.

Real seats use the stock `seat.cjs` entry, including its compile-cache setup.
`--real-entry direct` selects the older `mcp.cjs` entry for an explicit comparison;
`MSL_RESULT.seatEntry` and the printed header identify the arm. Each run gives children a fresh
private HOME, so the first seat starts with an empty cache and later seats can reuse it.
`NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` must be unset for real-seat runs.
Direct-entry results do not establish the stock-launcher limit.

`--process-memory` emits `MSL_RESULT` JSON at each step and a counted `MSL_DONE` summary.
It reads RSS/PSS/USS without heap snapshots or forced GC. Before and after the idle window,
it calls the manager's authenticated `ps` command and matches every successful spawn's ID and
lifecycle UID. A stale presence view, missing process, changed PID, failed spawn or unreadable
memory sample fails the run. These observations prove sampled mesh presence, not continuous
readiness or application health. The observer calls and memory reads are outside the CPU window;
the observer connection remains open during it. RSS includes shared pages and must not be added
to PSS or USS.

`--ram` retains the separate heap-profiling mode and cannot be combined with `--process-memory`.
Real-seat mode does not start the shared stub-seat host. Its connected count, CPU and memory
columns are `n/a`, not zero measurements; JSON records include `stubHostStarted: false`.
Stub mode still starts and measures that host. Real connector readiness comes from the
authenticated observations, not a stub-connected count. The fixture parent still runs real
Plane-3 delivery and lifecycle handling. Broker CPU uses the helper's owned broker PID.

### Shared broker control

Add `--spaces 2` to the dist, real, stock-entry process-memory invocation to start one Manager
and one data account per space on a single owned broker. `--steps` is the seat count per Manager;
JSON names both `requestedPerSpace` and `requestedTotal`. Other shared-mode combinations refuse.
The default single-space path is unchanged.

Every space has a private HOME and compile cache. Managers read their named account from one
host-owned secret store; the broker's system signer stays in the trusted fixture parent's memory.
Account-scoped native connection observations verify the Manager and connector user identities
on the same server, excluding sibling cohorts. The existing authenticated `ps`, lifecycle,
presence and PID checks still apply. Missing or truncated account observations fail the run.

Shared `MSL_RESULT` rows report each space plus one broker sample and one parent sample. Totals
count each distinct process once; the parent holds all Plane-3 contexts. Source/runtime hashes
identify the measured files. `MSL_TEARDOWN` reports verified process exit and directory removal;
`MSL_DONE` follows successful teardown. Cleanup uses recorded process identities, not process-name
sweeps. This is a synthetic static-auth, trusted same-UID fixture, not hostile-tenant isolation,
Cloud or model-session coverage. A small control does not establish a density limit.

## Remote authority clients

The package root exports `remoteManagerClient`, the stock request builders and response validators
used by the remote manager path, plus `registerRemoteManagerAuthority` and the
`RemoteManagerIdentityState` type. `managerClusterArtifacts()` provides the canonical document
and manifest used by registration and the activation request, with both digests. Embeddings can
use these without private module imports or a copied contract.
The namespace covers standing renewal, run admission and attempts, maintenance, enrollment and
retirement. Registration requires host-issued prepare credentials and uses the native registration
barrier. The host still authenticates requests and owns issuance policy; these helpers grant no
authority. Keep each account's five private manager identities separate, and retain the stock
account, identity, epoch and active-run checks when composing callbacks.

## Startup reconciliation

On an authenticated static mesh, the manager starts reconciling durable orphaned static slots,
then overlaps the remaining sweep with control-service registration. Startup logs each terminal as
`static reconcile terminal alias=<alias> phase=<phase> uid=<uid> attempt=<n>/<max>` and the sweep
total as `static reconcile completed: <n> attempted, <n> succeeded, <n> failed`. `cotal ps` becomes
available before a slow sweep completes. The no-race boundary is per alias: `spawn` for an alias
still reconciling refuses until that exact lifecycle terminal attempt returns; unrelated aliases and
read-only control remain available. A terminal error releases that alias fence so the sweep can
continue. The same process retries the alias after 1, 5 and 30 seconds; after the fourth failed
attempt it logs `retry-exhausted` and the slot stays held until the next manager start re-drives
it. An active orphan retires only after delivery-admin has verified its broker
principal gone. The broker result is persisted in the lifecycle's per-UID audit record before
cleanup and alias reuse. The orphan OS process is not reaped by this reconciliation path.

## Maintenance API

The admin control operations `preparePreservation {attemptId}` and
`commitPreservation {attemptId}` form a crash-safe handshake. Prepare fences new lifecycle/control
work, waits for already accepted work, and returns a `cotal-manager-resume/v2` non-secret inventory
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
the manager never calls `grantAgent` or provisions a replacement identity.

After restore, start the manager with `supervise --resume-attempt <id>`, wait for normal manager
readiness, then send the admin control request:

```json
{"op":"resumePreserved","args":{"attemptId":"<id>","inventory":{"version":"cotal-manager-resume/v2","space":"<space>","createdAt":"<iso>","agents":[]}}}
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

Active-mode `Manager.stop()` releases detachable manager-local custody and leaves agents running by
default; `stop({ withAgents: true })` is the explicit destructive teardown.

Only token-bound finalization releases ordinary destructive lifecycle semantics. Both operations are
same-attempt idempotent. A manager signal or lease loss after commit but before finalization remains
retention-safe, while failed or partial activation cannot be committed or finalized.
