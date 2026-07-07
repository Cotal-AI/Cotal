# @cotal-ai/connector-core

The shared MCP-bridge runtime: the mesh agent, the `cotal_*` tool specs (including
`cotal_spawn` / `cotal_persona` / `cotal_despawn`), and the hook relay. The connector adapters
(Claude Code, OpenCode, Hermes) are thin clients over it.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connect-claude.md](../../docs/connect-claude.md) for how a session
joins, and the [root AGENTS.md](../../AGENTS.md) for the tier rules.
