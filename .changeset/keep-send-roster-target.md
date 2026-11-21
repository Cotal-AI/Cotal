---
"@cotal-ai/cli": patch
---

When `send` cannot find a direct recipient or mention, its suggested `who --all` command keeps the broker and credential file used for the lookup. The command works even if the space is not registered on this machine.
