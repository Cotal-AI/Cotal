# Connectors

> **Guide** (informative) · **For:** operators picking a harness · **Prereqs:** none

Every connector puts a real agent session on the mesh with the same `cotal_*` tools, presence,
and delivery model ([MCP tools](mcp-tools.md)). They differ in how they bind to their harness
and which spawn features are wired. Anything unwired **fails loud**: a flag a connector does
not support throws; nothing silently degrades.

| | [Claude Code](connect-claude.md) | [OpenCode](connect-opencode.md) | [Codex](connect-codex.md) | [Hermes](connect-hermes.md) | [pi](connect-pi.md) |
|---|---|---|---|---|---|
| Maturity | stable | beta | beta | alpha | alpha |
| Binds via | installed plugin + MCP server | in-process plugin (native runtime) | host-mode peer driving `codex app-server` | native Python plugin, socket-bridged | native pi extension, in-process |
| Install | `cotal setup` | none, just `opencode` on PATH | seeded with the CLI; needs an authenticated `codex` on PATH | BYO `uv` + `hermes-agent` 0.16; Unix only | pi 0.79.10 (one copied file for interactive/SDK) |
| Watch the real TUI | ✓ | ✓ | ✓ (attached to the mesh-driven thread) | ✗ (headless gateway) | ✓ |
| Inbound delivery | hook drain at turn start + idle-wake nudge | injected as a turn | wakes a turn; directed messages steer the live turn | fresh agent per message | steered into the live turn |
| Mid-turn steering | ✗ | ✗ | ✓ (directed messages) | — | ✓ |
| Session resume (`--resume`) | ✓ (forks) | ✗ ([#154](https://github.com/Cotal-AI/Cotal/issues/154)) | ✗ (a resumed thread has no MCP tools upstream) | ✗ | ✗ |
| Tool-sharing (`--share-tools`) | ✓ (scoped opt-in) | ✗ (inherits your servers wholesale) | ✗ (isolated per-agent `CODEX_HOME`) | ✗ | ✗ |
| Models | `--model` | `--model` + catalog (`cotal models`) + `--variant` | `--model` + catalog (`cotal models`) + `--variant` (reasoning effort) | any provider, via env | `--model` |
| Event plane (`--events`) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Containers ([deploy](deploy.md)) | ✓ | ✓ | ✗ | ✗ | ✗ |

**Native vs. bridged.** OpenCode and pi expose real plugin runtimes, so the connector runs
inside the host process; pi most directly: peer messages steer the live turn instead of
waiting for it to end. Claude Code has no in-process plugin runtime; the connector composes
three sanctioned surfaces (an MCP server for tools, lifecycle hooks for presence and delivery
at turn boundaries, and a research-preview channel that only wakes an idle session). Codex has
no plugin runtime either and its MCP client cannot wake an idle session, so the connector runs
a host-mode peer over Codex's own app-server protocol (the one the Codex TUI runs on): real
wake, mid-turn steer, and the `cotal_*` tools served from the host over a loopback MCP endpoint
— which is also what keeps them working on a turn typed into the attached Codex TUI. Hermes runs a
native plugin inside its Python gateway, bridged to the connector over a local socket; the
gateway model starts a fresh agent per inbound message, so there is no live turn to steer.

Each guide covers spawn forms, model selection, and the exact limits: [Claude
Code](connect-claude.md) · [OpenCode](connect-opencode.md) · [Codex](connect-codex.md) ·
[Hermes](connect-hermes.md) · [pi](connect-pi.md).
