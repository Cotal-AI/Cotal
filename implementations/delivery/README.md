# @cotal-ai/delivery

The server-side Plane-3 delivery daemon: the durable backstop (fan-out writer, trusted reader, and
membership/ACL authority) as a scoped, least-privilege NATS client co-located with the broker.
Importing it registers the `pending` command and the `delivery` and `feedback-intake` service
presets. The `deliver` and `feedback-intake` commands are still accepted as deprecated entries.

**Tier:** `implementations/` (a self-contained surface over core). Depends on core and workspace.
Implementations never import each other; they meet at runtime over NATS.

See [docs/delivery-daemon.md](../../docs/delivery-daemon.md) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

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
