---
"@cotal-ai/cli": patch
---

`cotal down --yes` now works on every root. On a root without a controller stack, such as a prepared space that never started or a stack `up -f` started, it gives the same answer as `cotal down`: it stops the running stack, or reports that the stack is not running. It used to refuse with `UNSUPPORTED` because `--yes` applied only to a controller stack.
