---
"@cotal-ai/connector-core": minor
---

Persona ownership, env allow-list, MCP sharing, and the reconnect tool

- **`definePersona` content/policy split** with a write-once persistent file owner: a peer can't
  grant itself a capability or seize ownership of a persona file, and a persona-only edit can't
  silently clear an existing model. `role` is spawn-time policy and has been removed from the
  `cotal_persona` tool surface (advertising it was a silent no-op).
- **Spawned-child env allow-list** (`launch.ts`): runtimes receive only the declared env, never
  `process.env`, with per-connector model-key forwarding.
- **Opt-in per-connector MCP server sharing** for spawned agents.
- **`cotal_reconnect`** tool added to the shared tool surface (renders on both Claude Code and
  OpenCode) for manual mesh recovery. `cotal_purge` is dropped from the agent tool surface — it
  is admin-only now, so the operator path is `cotal history clear`.
- Agent transcript mirroring is now opt-in (default off); a spawn permission denial names the
  missing capability instead of blaming the manager.
