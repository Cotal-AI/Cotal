---
"@cotal-ai/connector-core": patch
---

The `completion` section of the CLI page, which ships in the bundled docs, now shows how to enable completion in the current bash, zsh, fish or PowerShell session, lists the files `cotal completion install` writes for each shell along with the `XDG_CONFIG_HOME` and `ZDOTDIR` overrides it honors, and explains that the installed stub resolves candidates through the local `cotal __complete` dispatcher. No behavior changes.
