---
"@cotal-ai/cli": patch
---

`cotal history clear --dry-run` now previews a space that was started directly with `cotal up --foreground` and then stopped, using the broker address its project retains, instead of refusing until the space is restarted. A confirmed clear of that stopped space is still refused.
