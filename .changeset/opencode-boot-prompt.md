---
"@cotal-ai/connector-opencode": patch
---

`cotal spawn --agent opencode --prompt <text>` now submits that text as the session's first turn.
The connector built its launch spec without ever reading the prompt, so an OpenCode seat accepted
the flag, joined the roster, loaded its persona, and then sat idle until something else woke it.
The prompt now rides the child environment to the in-process plugin, which submits it once, after
the session exists and the mesh link is up, and never again on a later readiness event. Peer
traffic that arrives during boot stays buffered and is delivered when that first turn ends, so the
operator's prompt really is the first turn. An initial prompt with no text in it is refused at
launch instead of being accepted and dropped.
