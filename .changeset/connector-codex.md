---
"@cotal-ai/connector-codex": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
"@cotal-ai/cmux": minor
"@cotal-ai/tmux": minor
"@cotal-ai/orca": minor
"@cotal-ai/cli": minor
"@cotal-ai/web": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/auth": minor
"cotal-ai": minor
---

New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer. A host-mode peer drives a headless `codex app-server` thread over JSON-RPC — inbound batches wake a real turn, directed messages steer INTO a live turn mid-flight, and the shared `cotal_*` tools are served natively as app-server dynamic tools from one embedded endpoint (no MCP sidecar; Codex's MCP client cannot wake an idle session). At-least-once delivery with exact-id acks on turn completion (failed turns retry with backoff; interrupts and crashes redeliver), presence from the event stream, a live activity feed for `cotal attach`, an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (dynamic tools are start-only upstream) and tool-sharing.
