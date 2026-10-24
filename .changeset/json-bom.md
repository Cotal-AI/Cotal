---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A `.cotal/channels.json`, `--channels` file or `preferences.json` that begins with a UTF-8 byte-order
mark, as some Windows editors write, now reads as the JSON after it. Before, `cotal up` refused the
channels file, and such a preferences file stopped nearly every command, with a parser message that
showed the mark as an invisible character.
