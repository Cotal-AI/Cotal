---
"@cotal-ai/cli": patch
---

`backup create` and `up --restore` on a stack a plain `cotal down` stopped now say to start it with `cotal up` before `cotal down --preserve-state`. They used to name only `down --preserve-state`, which refuses on a stopped stack.
