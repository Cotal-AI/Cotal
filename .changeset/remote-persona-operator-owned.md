---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

`cotal persona create --on <manager>` on a static space no longer records the CLI's one-call caller as the persona's owner, which no later call could match, so the receipt's own `persona show --on` Next was refused. On a static space the manager now records an owner only for one of its own seats, and any other caller defines an operator-owned file, as a local `persona create` writes it. A peer joined with its own credentials is such a caller too. When the manager writes the file into this root's catalog, the receipt's `Local files` line names it instead of saying `unchanged`, and JSON `localFilesChanged` is true. For a one-call caller the Next offers `cotal p show <name>`, and a `persona show --on` that is answered not-found names that command when this root holds the file.
