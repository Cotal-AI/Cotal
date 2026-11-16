---
"@cotal-ai/cli": patch
---

`cotal manager start --dry-run`, and `cotal service start <preset> --dry-run`, with an option that differs from a stopped service's saved one no longer save the definition again. Before, the preview rewrote it, so the next real start used the previewed `--runtime` and could fail with `unknown runtime`. The dry run still makes the same checks.
