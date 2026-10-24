---
"@cotal-ai/cli": patch
---

`cotal down` and `cotal down --dry-run` in a folder with no stack, on a machine that has no stack started or registered at all, now say so and name `cotal up` in a project as their next step, as `cotal status` does. They used to send you to the folder where `cotal up` started the stack, when no such folder exists.
