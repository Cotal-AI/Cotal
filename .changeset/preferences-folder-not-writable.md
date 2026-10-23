---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`config set` and `config unset` in a preferences folder you cannot write are now refused with
`PERMISSION_DENIED`, exit 2, naming the folder and how to make it writable. Before, they reported
a raw `EACCES` as an unknown outcome, exit 3, although nothing had changed.
