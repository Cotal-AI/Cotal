# @cotal-ai/core

The Cotal protocol: the endpoint, subjects, and message types, plus the NATS client layer and
the extension contracts (`Connector`, `Command`, `Runtime`) and the `Registry` they
self-register into.

**Tier:** `packages/` (the standard). Workspace, the implementations and the extensions depend on
core; core depends on nothing else in the repo, and neither do `@cotal-ai/lang` and
`@cotal-ai/seat`.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules, [SPEC.md](../../SPEC.md) for the
normative wire contract, and [docs/](../../docs/) for the protocol.

## Idle-load broker comparisons

`pnpm -C packages/core smoke:seat-idle-load` expects NATS Server 2.15.1 by default.
For an explicit version comparison, set `NATS_SERVER_BIN` to the verified broker binary and
pass `--server-version X.Y.Z`. The reported binary version must match; missing or malformed
version values refuse before broker setup. Selecting a version does not change configuration,
workload or installed defaults, and a successful run is not upgrade qualification.

Keep source, workload and preparation fixed across comparison arms. Use ordinary runs for
operating headroom; `--ram` invokes forced-GC profiling and perturbs memory residency.
