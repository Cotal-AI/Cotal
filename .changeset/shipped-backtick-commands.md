---
"cotal-ai": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
"@cotal-ai/linear": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
"@cotal-ai/web": patch
---

Remedies, hints and messages from `run`, `actor` and `auth`, `logout`, `supervise` and `manager`, `deliver`, `docs`, `daemon`, `linear`, the web dashboard, the console, the Claude Code connector, a run's checkpoint prompt and the endpoint issuance gate now name the commands they suggest in backticks, so a terminal keeps each one whole and `--json` carries the same text. They named them bare after other words, as in "list the recorded runs with cotal run", which split inside the command when the line wrapped.
