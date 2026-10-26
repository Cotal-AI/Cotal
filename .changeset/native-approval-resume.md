---
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/cli": patch
---

A personal Claude Code conversation whose `cotal_connect` is awaiting approval no longer depends on the person coming back to say "retry". The plugin's server follows the pending request, serialized with the conversation's own connect, until the authority records the decision, the request expires, or the session ends. An approval finishes the same request and holds the issued identity for that conversation's `cotal_connect` with its `approval_id`; the person's decision reaches only the native session that asked, through its wake reader, as one fixed approved, denied or expired line that the native module admits exactly. An approved identity nobody claimed is retired when its session ends. `cotal app-identity provision` now reports a recorded refusal as `refused: denied | expired | refused` beside its message, so a host never classifies a decision from prose.
