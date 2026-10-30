# @cotal-ai/delivery

The server-side Plane-3 delivery daemon: the durable backstop (fan-out writer, trusted reader, and
membership/ACL authority) as a scoped, least-privilege NATS client co-located with the broker.
Importing it registers the `pending` command and the `delivery` and `feedback-intake` service
presets. The `deliver` and `feedback-intake` commands are still accepted as deprecated entries.

**Tier:** `implementations/` (a self-contained surface over core). Depends on core and workspace.
Implementations never import each other; they meet at runtime over NATS.

See [docs/delivery-daemon.md](../../docs/delivery-daemon.md) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Native transport regression

After `pnpm build`, run `pnpm smoke:delivery-transport-health` with `nats-server` on PATH.
The suite owns its broker and temporary state. Its 15 checks exercise the transport-health
class directly, including failed credential adoption, reconnect recovery and sustained broker
loss. The CI smoke registry runs it alongside the daemon-level native-health suite.

## Load-harness delivery checks

`pnpm -C implementations/delivery smoke:fanout-load --members 50 --rate 10 --seconds 30`
reports aggregate delivery counts by default. Add `--verify-delivery` to compare acknowledged
publish IDs against durable IDs observed by each configured recipient, including a check that the
poster receives no durable self-copy. The final rows report distinct, expected, missing,
unconfirmed and repeated copies per member. Repeats are allowed by at-least-once delivery.

Verification exits nonzero for incomplete coverage, unconfirmed IDs, startup or publish failures,
endpoint errors at the sample, or an empty workload. A publish timeout has unknown outcome, so an
unconfirmed ID does not prove foreign traffic. Missing means not observed at the final sample,
not permanent loss. This mode does not verify live copies, payload integrity or ordering.

ID tracking costs O(posts × members) memory and extra callback work. Use it as a separate
correctness workload; do not compare its CPU or memory numbers with ordinary load runs.
`pnpm smoke:delivery-coverage` runs the accounting controls without starting a broker.

## Active multi-space measurement

`COTAL_MSD_SECONDS=30 COTAL_MSD_RATE=2 pnpm smoke:delivery-multi-space --measure --measure-shape host16 --sublist-cache off`
runs the built delivery CLI against one native broker with 16 separate accounts and three members
per space. It reads every account's ready delivery lease before starting members; the host-up
message alone can describe partial startup. Use `--sublist-cache on` for the cache-enabled arm. `--measure-shape single16` selects
16 delivery processes; the default `all` runs the historical 1/4/16/shared/single comparison on
reused stores. Select one shape per invocation for fresh-state comparisons. The broker comes from
`PATH`; pin its binary there when comparing runs. Duration and rate must be positive finite
numbers whose rounded-up product is a positive safe integer; validation precedes broker setup.

`MSD_RESULT` reports broker and delivery CPU seconds and RSS in MiB, elapsed window and per-space
accepted publishes, copies and endpoint errors. Measurements include a five-second allowance and
up to 30 more seconds for receiver completion. Counts and errors affect the exit status. Add
`--verify-delivery` for the same per-recipient acknowledged-ID checks as fanout-load; its tracking
has overhead, so use a separate correctness run. Repeated copies remain allowed. Receiver
completion is not proof of empty broker queues. The test does not model hosted agents, connect
auth callouts, subject churn or message ordering, and process RSS values are not additive.

For a separate `host16` diagnostic, add `--cpu-profile-dir /absolute/new/private-directory`.
The directory must not exist; its parent must exist. The actual delivery CLI child writes
`delivery.cpuprofile` using Node's standard CPU profiler, covering startup through graceful exit.
`broker.pprof` is a native CPU profile requested as posting begins for the smaller of 60 seconds
and the rounded-up configured posting duration (at least one second). `broker-window.json`
records request/response timestamps. The broker profiler listens only on loopback. No heap
profile, forced GC or memory limit is enabled. Output remains outside fixture teardown.

Both profiles add overhead and cover different intervals; do not compare diagnostic throughput
with ordinary runs or treat full-child delivery samples as measured-window-only samples. Missing
or failed profile output fails the diagnostic. Profile paths and stack metadata are private
operator evidence, not production tenant telemetry.
