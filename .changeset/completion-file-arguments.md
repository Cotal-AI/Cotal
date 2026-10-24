---
"@cotal-ai/cli": patch
---

File arguments tab-complete in bash and zsh. A completer that answers with the `default` directive,
as `team check <file>`, `up -f` and `--channels` do, now gets the shell's own file names. The stubs
used to drop that directive, and bash registered the completion without `-o default`. A value with
a fixed set of choices still offers no files. Reinstall the stub with `cotal completion install`.
