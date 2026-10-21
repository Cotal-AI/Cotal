---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Name the next step when an auth command has no space to act on or a grant cannot apply there.

- On a static or open space, `cotal auth grants`, `grant` and `revoke` and their `cotal actor` spellings refuse with `UNSUPPORTED` and say that actor grants apply only to a space started with `cotal up --user-auth`. On any other space the refusal still points to the machine and root that hold its ledger, and a refused revoke says nothing was revoked instead of "no inert grant was written".
- With no space to resolve, the auth grant commands and `cotal auth mint` refuse with a next step, such as `cotal up`. `cotal doctor auth` in a folder whose root holds no space adds a remedy to its partial result: run it in a space's root, which `cotal space` lists.
- Bare `cotal auth` fills its Next lines with the `--space` you gave or the space it resolves, and points to `cotal space` when there is none, instead of printing an unfilled `--space <space>`.
- The `cotal doctor` help line describes the report it prints, instead of promising it ends in `healthy` or a next command.
