---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/manager": minor
---

A Claude Code seat that Cotal launches on a signed-in space now lets its owner answer Claude's tool permissions from another session, while Claude's own dialog stays open.

The plugin registers `PermissionRequest` and `SubagentStop`. The hook relay holds a `PermissionRequest` past its 2-second deadline once a proven connector has it, and the control server passes each handler a signal that aborts when the hook's connection closes. The connector opens each permission as a prompt on the agent's own `agent` endpoint, offered for 7 days, and hands Claude the remote allow or deny. It settles a prompt from what Claude reports later: a closed hook connection, a batch that ran a call with the same scope, tool and input, or the end of that scope's turn. `AskUserQuestion` and `ExitPlanMode` stay with Claude's dialog. On Windows the hook answers each permission itself with no decision and the connector warns once. `MeshAgent.prompts` exposes the agent's prompt desk to a connector. A connector can declare `prompts`, and every Manager `status.connectors` row now carries `prompts`, true when the connector declares it and the mesh is user-auth. The Manager cluster advances to revision 52, whose closed status schema a revision-51 reader rejects. `HookHandle` takes a third argument, the hook's connection context, so code that calls a handler typed as `HookHandle` passes one.
