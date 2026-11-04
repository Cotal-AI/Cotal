# @cotal-ai/web

The browser dashboard, as an extension package that adds the `web` service preset
(`cotal service start web`). It ships inside `cotal-ai` and is seeded automatically on first run.

**Tier:** `implementations/`. Peer-depends [`@cotal-ai/core`](../../packages/core) and
[`@cotal-ai/workspace`](../../packages/workspace); self-registers on import.

The Monitor roster, waiting cards and agent details, and the graph's agent details show
reported conditions and status, activity and work ages. Both pages use core's
`presence-ages` browser module: missing stamps stay unknown and ages floor to whole units.

See [docs/watch-a-mesh.mdx](../../docs/watch-a-mesh.mdx) and the [root AGENTS.md](../../AGENTS.md)
for the tier rules.
