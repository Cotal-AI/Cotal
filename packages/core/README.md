# @cotal-ai/core

The Cotal protocol: the endpoint, subjects, and message types, plus the NATS client layer and
the extension contracts (`Connector`, `Command`, `Runtime`) and the `Registry` they
self-register into.

**Tier:** `packages/` (the standard). Workspace, the implementations and the extensions depend on
core; core depends on nothing else in the repo, and neither do `@cotal-ai/lang` and
`@cotal-ai/seat`.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules, [SPEC.md](../../SPEC.md) for the
normative wire contract, and [docs/](../../docs/) for the protocol.

## Local persona catalog

`readPersonaCatalog(root)` is the filesystem reader shared by core and the CLI. It returns an
empty catalog only for an absent directory; unreadable or unsearchable directories throw. Entries
retain parse errors, UTF-16 diagnostics, non-regular-file markers and symbolic-link targets.
`listPersonaCatalog(root)` keeps its existing empty-list policy for unreadable catalogs and uses
the same reader. The manager still filters ownership and omits local file details from peer replies.

## Idle-load broker comparisons

`pnpm -C packages/core smoke:seat-idle-load` expects NATS Server 2.15.1 by default.
For an explicit version comparison, set `NATS_SERVER_BIN` to the verified broker binary and
pass `--server-version X.Y.Z`. The reported binary version must match; missing or malformed
version values refuse before broker setup. Selecting a version does not change configuration,
workload or installed defaults, and a successful run is not upgrade qualification.

Keep source, workload and preparation fixed across comparison arms. Use ordinary runs for
operating headroom; `--ram` invokes forced-GC profiling and perturbs memory residency.

For GC and scavenger diagnostics, add `--go-trace`. It enables native Go `gctrace` and
`scavtrace` only for the broker, preserving other inherited `GODEBUG` settings. The harness
prints those lines with `broker-go utc_epoch_ms=<receipt time>`; the timestamp records when
the parent received a line, not the exact collection time. Native trace fields depend on the
broker's Go version. No memory cap or GC policy changes. Omit `--ram` to observe collections
without the profiler forcing them, and keep traced runs separate from performance comparisons.

To name what the broker allocates, add `--broker-prof <dir>`. The harness writes the broker's
pprof allocation profile (`/debug/pprof/allocs`) into that directory twice without forcing a
collection: `window-start.pb.gz` before the window's first counter is read and `window-end.pb.gz`
after its last. The Go runtime samples allocations at its default rate regardless. Compare the
profiles with:

```sh
go tool pprof -top -sample_index=alloc_space -unit=bytes \
  -base <dir>/window-start.pb.gz <nats-server> <dir>/window-end.pb.gz
```

`-base` reports shares of the allocation difference; `-diff_base` instead uses the base profile's
total for percentages. The [runtime profile](https://pkg.go.dev/runtime#MemProfile) can lag by up
to two GC cycles, so the difference covers delayed snapshots, not the exact wall-clock window.
A short window can produce equal allocation totals. Retain the collection trace and use a window
covering several cycles. These are sampled allocation counts, not a live-memory census or an
exact reconciliation with the trace's rounded heap figures.

`pnpm smoke:seat-idle-go-trace` runs native default and opt-in controls. It requires Linux
and NATS Server 2.15.1. Other platforms or broker versions emit an explicit skipped sentinel
with zero executed cells; a missing or unreadable broker remains a failure.
