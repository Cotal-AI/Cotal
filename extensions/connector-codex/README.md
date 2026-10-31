# @cotal-ai/connector-codex

The OpenAI Codex adapter: a host-mode peer that drives `codex app-server`, with Codex's own TUI
attached and the `cotal_*` tools served over a loopback MCP endpoint. A thin client over
[`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connect-codex.mdx](../../docs/connect-codex.mdx) for the integration guide, and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

The host, dist, installed-path and events-lifecycle smokes are POSIX-only. On Windows they emit
`skipSuite`'s canonical skip sentinel, so the shard records a skip with no passing cells and
continues to its next suite; this is not Windows connector coverage.
