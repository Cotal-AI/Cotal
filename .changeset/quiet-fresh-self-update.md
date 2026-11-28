---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

When the CLI is already current, `cotal update --self` on a fresh installation leaves built-in connector setup to the first command that needs it, without printing internal store paths during automatic setup.
