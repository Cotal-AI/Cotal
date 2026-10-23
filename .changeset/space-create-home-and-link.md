---
"@cotal-ai/cli": patch
---

`cotal space create` no longer exits 3 with an unknown outcome and a raw Node error when the folder it writes cannot take the space. A Cotal home (`~/.cotal` or `COTAL_HOME`) this account cannot write now refuses `PERMISSION_DENIED`, exit 2, naming that folder, and the empty project `.cotal` the attempt made is removed, so nothing is left behind. A project `.cotal` that links to a folder that does not exist refuses `TARGET_NOT_FOUND`, exit 2, naming the link and its target. Nothing is written in either case, and `cotal setup` refuses the same way.
