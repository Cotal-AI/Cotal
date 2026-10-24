---
"@cotal-ai/runtime": patch
---

`cotal run` refuses a mesh it cannot resolve or connect to under the refusal's own code, before any request, hosted or `--local`. With no mesh running, `cotal run ps` is refused `TARGET_NOT_FOUND`, exit 2, with one refusal envelope under `--json`, as `cotal ps` is. Before, it printed a plain line and exited 1 with no envelope.
