---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A leading flag typed with a typographic dash, such as `cotal ––json status` or `cotal −−version`, is now refused naming the flag to type with hyphens, as the same word after the command word already was. It was reported as an unknown command, and `−−version` was offered the `version` command.
