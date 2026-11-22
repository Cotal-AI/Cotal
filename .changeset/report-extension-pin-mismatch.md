---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Report a partial extension inventory when the installed version differs from the recorded pin. The inventory and the command that refuses to load the mismatched package both give the appropriate reinstall step, including for a local path containing spaces.
