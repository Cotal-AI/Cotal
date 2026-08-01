---
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer. A host-mode peer drives a headless `codex app-server` thread over JSON-RPC: inbound batches wake a real turn, directed messages steer INTO a live turn mid-flight, and the shared `cotal_*` tools are served natively as app-server dynamic tools from one embedded endpoint (no MCP sidecar; Codex's MCP client cannot wake an idle session). At-least-once delivery with exact-id acks on turn completion: a failed turn retries with backoff, an interrupt redelivers, and an app-server crash restarts the child in place on the same mesh lifecycle and re-drives the un-acked batch (a crash loop is fatal, never an endless respawn). Presence from the event stream, a live activity feed for `cotal attach` that also reads its terminal back (a typed line is a real user turn: it starts one when the agent is idle and steers into the running turn when it is busy, so a foreground spawn and `cotal attach` are both interactive), an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (dynamic tools are start-only upstream) and tool-sharing.

Also fixes the seed reconciler, which treated a generation match alone as up-to-date: a built-in connector added at an unchanged generation would never seed on an already-installed workstation (`--agent codex` reporting no connector installed). Both fast paths now also require every `SEED_BUILTINS` entry to be present in the ever-seeded set.
