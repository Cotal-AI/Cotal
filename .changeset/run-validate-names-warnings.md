---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run validate`, `plan` and `simulate` now say what each validator warning is: its code, title, position, cause and fix, on stderr and in the `--json` envelope's `warnings`, and `validate --json` lists each one under `result.warnings` with the same fields. Before, a warning printed only "The language validator reported a warning at this source position.", so a `fanOut` over a literal list with no `key` validated with no visible reason and then failed its run with L3021.
