---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

On Linux, `cotal update` refreshes integrations without asking to stop agents when the installation and its background service are current, even when Claude Code has generated TypeScript files for the installed connector.
