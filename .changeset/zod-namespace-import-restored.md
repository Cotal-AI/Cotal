---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
---

Restore the tool specs' and gateway's zod namespace import. The by-name imports released in 0.133.9 made the bundled claude, codex, hermes, jcode and opencode connectors throw `Class2 is not a constructor` when imported, so a fresh `cotal setup` failed its first connector seed.
