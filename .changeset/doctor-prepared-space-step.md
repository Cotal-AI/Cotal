---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal doctor auth --space <space>` for a space that was prepared and never started now says to start it with `cotal up` first, instead of telling the user to run the same command in the folder they are already in. From another folder, that step names the space's root with `--root`, quoted for a shell. The refusal and its exit code are unchanged.
