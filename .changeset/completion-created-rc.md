---
"@cotal-ai/cli": patch
---

`cotal completion uninstall` now removes a `.bashrc` or `.zshrc` that `install` created when nothing else is left in it, instead of leaving an empty file. A startup file that was there before install stays, even empty.
