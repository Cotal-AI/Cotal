# @cotal-ai/connector-core

The shared MCP-bridge runtime: the mesh agent, the `cotal_*` tool specs (including
`cotal_spawn` / `cotal_persona` / `cotal_personas` / `cotal_despawn`), and the hook relay. The connector adapters
(Claude Code, OpenCode, Codex, Hermes, Jcode, and pi) are thin clients over it.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connectors.mdx](../../docs/connectors.mdx) for how the adapters compare,
[docs/mcp-tools.mdx](../../docs/mcp-tools.mdx) for the tool catalog generated from these specs,
[docs/connect-claude.mdx](../../docs/connect-claude.mdx) for how a session joins, and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

Attribution fields use core's `peerLabel` sanitizer, the same policy as roster labels:
C0/C1 controls, Unicode line/paragraph separators and brackets become spaces. Ordinary
Unicode and surrounding spacing are preserved; channel/kind renderers keep their own
existing trim and empty-value labels. Message-body formatting remains separate.
