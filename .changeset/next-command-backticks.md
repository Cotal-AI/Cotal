---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A remedy, Next line, hint or message that names a `cotal` command after other words now writes it in backticks, so a terminal wraps the command as one word and never splits it across lines. At 80 columns the timed-out `invoke` Next used to break inside `cotal invoke manager ps --timeout 10000`, the `TARGET_UNAVAILABLE` Next inside `cotal service --space <space>`, and the note about a folder's stopped space inside its `cotal up`. At 60 columns the `up` and `spawn` option help broke inside `cotal down` and `cotal team deploy <file>`. `--json` carries the same text, with the backticks; no key changed. A command that holds a shell-quoted path or value is named between double backticks when it holds a backtick itself.
