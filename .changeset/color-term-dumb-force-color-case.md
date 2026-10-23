---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Output is no longer colored on a terminal whose `TERM` is `dumb`, unless `FORCE_COLOR` asks for it,
and `FORCE_COLOR` set to `false` in any letter case, such as `FALSE`, now turns color off as `false`
does.
