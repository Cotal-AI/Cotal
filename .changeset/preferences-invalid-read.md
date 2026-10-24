---
"@cotal-ai/cli": patch
---

An invalid or linked `preferences.json` no longer stops `cotal version`, `cotal docs` or `cotal status`. Version and docs use no preference and run as usual. Status reports the file as a part it could not read, naming it and the problem, with "fix or remove <path>; nothing resets it" as its next step, and exits 4. Help's notice that status reports the affected records is now true. Every command that could act on a default, such as `config`, `spawn` or `ext`, still refuses.
