---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
---

On Linux, `cotal update` refreshes integrations without asking to stop agents when the installation and its background service are current, even when Claude Code has generated TypeScript files for the installed connector.
