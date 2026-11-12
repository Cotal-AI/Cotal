---
"@cotal-ai/cli": patch
---

`cotal update` on Linux no longer needs `ps` on PATH. Since 0.163.1 the update listed local Managers with `ps` and refused with "the process table could not be listed" where it was missing, as in slim container images or a narrow service PATH. It now reads `/proc` directly.
