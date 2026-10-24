# @cotal-ai/connector-codex

The OpenAI Codex adapter: a host-mode peer that drives `codex app-server`, with Codex's own TUI
attached and the `cotal_*` tools served over a loopback MCP endpoint. A thin client over
[`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connect-codex.md](../../docs/connect-codex.md) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
