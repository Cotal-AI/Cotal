---
"@cotal-ai/cli": patch
---

A bare `cotal space show` in a project folder shows that folder's space when nothing is selected, as every other command there targets it. Before, it refused with "no space is selected" unless some other space was selected. Outside a project with nothing selected it still refuses.
