---
"@cotal-ai/cli": patch
---

`cotal service start <name> --space <space>` now suggests show and stop commands for that space. It suggested `cotal service show <name>` and `cotal service stop <name>`, which from another folder act on the selected space and are refused there.
