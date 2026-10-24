# @cotal-ai/delivery

The server-side Plane-3 delivery daemon: the durable backstop (fan-out writer, trusted reader, and
membership/ACL authority) as a scoped, least-privilege NATS client co-located with the broker.
Importing it registers the `deliver` command.

**Tier:** `implementations/` (a self-contained surface over core). Depends on core and workspace.
Implementations never import each other; they meet at runtime over NATS.

See [docs/delivery-daemon.md](../../docs/delivery-daemon.md) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
