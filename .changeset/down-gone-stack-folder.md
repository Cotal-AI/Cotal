---
"@cotal-ai/cli": patch
---

`down --space <space>` from any folder now stops a controller stack whose folder was deleted. It
signals each running member's recorded process, manager first and broker last, records each stop,
and removes the stack's saved definitions and registration so the space can start in another folder.
Before, every stop route refused because the broker configuration was gone, and the space name could
not start anywhere on that machine. `status` now marks such a project folder as gone and names that
`down`, and so does `space forget` when it keeps the definitions of such a stack.
