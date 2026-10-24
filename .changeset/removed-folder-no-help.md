---
"@cotal-ai/cli": patch
---

A command run from a folder that no longer exists printed its refusal and the `cd` remedy, then the command's whole help, 50 lines for `cotal up`. It now prints only the refusal and the remedy, as a missing `--yes` does. The exit code and the JSON envelope are unchanged.
