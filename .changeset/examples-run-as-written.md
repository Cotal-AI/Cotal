---
"@cotal-ai/cli": patch
---

Three help examples now run as written. The `persona create` example passes `--subscribe ""`, which a persona made from a prompt needs, and the usage marks `--subscribe` required with `--prompt` or `--from`. The `space add` examples pass `--root <dir>`, which they need outside a project. The `completion uninstall` example's note says it removes the completion file for your shell, the one `SHELL` names. A usage refusal now shows the help `--help` prints for the same words, so a refused `persona create` shows the `persona create` help instead of the `persona` help.
