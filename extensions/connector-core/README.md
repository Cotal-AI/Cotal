# @cotal-ai/connector-core

The shared MCP-bridge runtime: the mesh agent, the `cotal_*` tool specs (including
`cotal_spawn` / `cotal_persona` / `cotal_personas` / `cotal_despawn`), and the hook relay. The connector adapters
(Claude Code, OpenCode, Codex, Hermes, Jcode, and pi) are thin clients over it.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connectors.md](../../docs/connectors.md) for how the adapters compare,
[docs/mcp-tools.md](../../docs/mcp-tools.md) for the tool catalog generated from these specs,
[docs/connect-claude.md](../../docs/connect-claude.md) for how a session joins, and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

Attribution fields use core's `peerLabel` sanitizer, the same policy as roster labels:
C0/C1 controls, Unicode line/paragraph separators and brackets become spaces. Ordinary
Unicode and surrounding spacing are preserved; channel/kind renderers keep their own
existing trim and empty-value labels. Message-body formatting remains separate.

Bundled docs use two length/SHA256-coupled data files beside each ESM/CJS carrier.
Text and structured indexes use generated metadata without reading either file. A search
checks both assets, decodes the precomputed index, and decodes only the source bodies of
its selected hits. Pages and searches share per-source caches. Corpus sources are ordinary
JSON string records in independent gzip members; no new dependency or public async API.
`loadDocsBundle()` still materializes the complete corpus for build tooling. Structured
index results remain independently mutable. Package/plugin layouts retain the same two assets.
