# @cotal-ai/connector-opencode

The OpenCode adapter: a native in-process plugin injected at launch via
`OPENCODE_CONFIG_CONTENT`, rendering the shared `cotal_*` tools as plugin tools. A thin client
over [`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/architecture.md](../../docs/architecture.md) (*Connector runtime*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
