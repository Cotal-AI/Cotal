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

Bundled docs use an inline gzip/base64 payload generated from the versioned sources.
`loadDocsBundle()` decodes it synchronously on demand; reading `DOCS_VERSION` does not decode it.
The existing docs and search caches retain their first-use behavior. The payload stays inside
each ESM or CJS bundle, so package and plugin asset layouts do not change.
