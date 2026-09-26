---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/pi": patch
---

A manifest or spawn prompt on a connector that cannot deliver one is refused at preflight (including `up -f --dry-run`), at spawn and in the manager, the way an unsupported model variant is: connectors now declare `supportsPrompt`, and claude, opencode, codex, jcode and pi declare it; hermes keeps its launch-time throw as the second line of defence.
