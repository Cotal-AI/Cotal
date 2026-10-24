---
"@cotal-ai/cli": patch
---

`cotal use --clear` removes the space selection, so a command targets its folder's space again. Nothing could clear it before: `use ""`, `use -` and `use none` were refused as unknown spaces, so after the first `up` selected a space, the rule that a folder's space applies when nothing is selected could not be reached again. The receipt names the space that was selected, `--json` reports it, and with nothing selected the command is a no-op.
