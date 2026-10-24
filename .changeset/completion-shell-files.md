---
"@cotal-ai/cli": patch
---

The bash and zsh completion stubs now complete file names where a value takes a path, such as `cotal team check <TAB>` or `--creds <TAB>`. They dropped that hint before, so a path never tab-completed. Run `cotal completion install <shell>` to refresh an installed stub.
