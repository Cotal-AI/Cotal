---
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`cotal service add web --preset web` now refuses `--posting-creds` without `--no-read-only`, or `--no-read-only` without `--posting-creds`, and saves nothing. Before, it saved the definition and every start was refused. A start of a saved dashboard definition with either problem, or with a wildcard `--host`, now names the one condition that failed and the `cotal service remove` and `cotal service add` that change it. A wildcard host no longer prints the usage of `service start`. A preset refusal while `service add` builds a definition no longer prints the command's usage after a remedy that already says the whole fix.
