---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-opencode": minor
---

An agent's owner can now interrupt the agent's running turn, so commands queued behind a turn that hangs can run. The `agent` endpoint advances to revision 3 with `interrupt`, which only the owner's interactive session may call and which answers `interrupted`, or `idle` when no turn ran. A connector offers it through an optional `interrupt()` on its command dispatcher; the OpenCode 2.x plugin posts OpenCode's own `/api/session/:id/interrupt`, and the stopped turn ends as a Stop at the terminal does. An agent never interrupts its own turn.
