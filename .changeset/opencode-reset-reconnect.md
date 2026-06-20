---
"@cotal-ai/connector-opencode": minor
---

Context reset, local auth reuse, and reconnect for spawned OpenCode agents

- `/new` is adopted as a context reset that keeps operator logins.
- Spawned agents reuse local auth.
- The busy guard releases on any turn end, so channel push survives human turns.
- A `/reconnect` slash command (injected via `OPENCODE_CONFIG_CONTENT`) drives manual mesh
  recovery.
