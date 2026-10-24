---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
"cotal-ai": patch
---

A step that a race cancelled in a losing branch now says so. `run show` labels its row
`cancelled, <branch> won <race>`, and `run answer` at that step is refused with `that step was
cancelled because branch <branch> won the race <race>` instead of `that step has already settled`.
