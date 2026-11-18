---
"@cotal-ai/cli": patch
---

Refuse unlaunchable agent names in direct spawn previews. Apply the launch's effective-name validation to persona names and `--name` overrides, including user-auth actor restrictions, before reporting a successful dry run.
