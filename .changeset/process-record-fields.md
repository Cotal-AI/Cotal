---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": patch
---

`ProcessRecord` carries only the fields its state has. A missing or empty record is `absent` and carries nothing. A record that is not a pid is `unattributable` and carries that content. `dead` and `unknown` carry the pid. `alive` and `foreign` carry the pid and, when the command line was read, the command. A caller that reads `pid` on an absent or unattributable record, or `content` on any other state, fails to compile. `readProcessRecord` already returned these shapes, and its results are unchanged. The manager and delivery refusals name the same pid they named before.
