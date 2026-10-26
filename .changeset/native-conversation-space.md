---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Let personal Claude Code conversations choose a registered mesh with `cotal_connect`'s optional `space` argument, without changing project configuration. Keep hosted grants space-bound, require disconnect before replacing a live connection, and retire a previous space's pending identity before requesting another.
