---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

The `run` command's usage line, receipts and next steps, and the run docs, now name the canonical
forms: bare `cotal run` to list runs, `run show` and `run check`. `ps` (or `list`), `journal` and
`migrate` still work, and the CLI reference lists them as compatibility aliases.
