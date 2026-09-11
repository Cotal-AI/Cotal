---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-claude-code": patch
---

Honor connector-declared startup confirmation prompts in PTY seats by matching normalized terminal output, pressing Enter only when the prompt appears, and failing with a named bounded error when it does not.
