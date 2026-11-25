---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/acp": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/pi": minor
---

In ACP clients such as T3 Code, choosing another model or reasoning level on a running thread now switches its agent from the next turn, with no `/despawn`.

- The `agent` endpoint advances to revision 6 with the owner-only `set-model`, and presence `agentEndpoint` gains `setModel`. Reconnect clients after the auth callout is updated, so their sign-in carries the new command.
- Codex switches with `thread/settings/update`, OpenCode with the model each prompt carries (1.x) or its session model route (2.x), pi 0.84.3 or later with its session setters, Jcode with its model and effort calls, and Claude Code through its command mod for later turns of the session alone. Each checks the model against its own list first. Hermes does not switch yet, and the thread says to use `/despawn`.
- A Manager keeps the switch and restarts or resumes the agent on it.
- An agent whose role `modelPolicy` governs refuses every switch, since the policy is checked only at launch.
