---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
---

A forked Claude Code session no longer acts under the hosted Cotal connection of the session it was forked from. A fork inherits the parent's `connection_id` in its transcript, so before this it reused the parent's mesh name from a new session. The plugin now records which session opened each hosted connection, from a `PostToolUse` hook on `cotal_connect`, in the plugin's data directory, and its `PreToolUse` hook refuses that id in any other session with a reason that says to call `cotal_connect`. A resumed session and its subagents keep the session id and are unaffected, and `cotal_disconnect` releases the record. `runHookRelay`'s local answer now runs in every session and is told whether the session carries a mesh identity.
