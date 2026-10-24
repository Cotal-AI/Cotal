---
"@cotal-ai/runtime": patch
---

`run check` and `run migrate` on an edited program that does not validate print each problem's
code, position, cause and fix instead of only the problem count. `run show` on a run that failed
outside any step says no journal row records why and names the stack manager's log.
