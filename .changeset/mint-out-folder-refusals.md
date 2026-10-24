---
"@cotal-ai/cli": patch
---

`cotal auth mint --out` names the folder it cannot write through. A symbolic link among the output's folders is refused `PERMISSION_DENIED`, naming the link, the folder it points to and the same file named without the link. A path through a file is refused `USAGE_INVALID`, and a folder this account cannot create is refused `PERMISSION_DENIED`, each naming the folder. Before, all three were refused `SCHEMA_INVALID` with "native credential preparation failed" and no path or next step.
