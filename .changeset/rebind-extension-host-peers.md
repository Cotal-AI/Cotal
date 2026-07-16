---
"cotal-ai": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Rebind extension peer links to the current Cotal host before lazy import, allowing global installs and source worktrees to share one extension prefix. Keep the Hermes launcher self-contained so it does not resolve a mutable host peer after launch.
