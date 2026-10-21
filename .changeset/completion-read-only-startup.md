---
"@cotal-ai/cli": patch
---

`cotal completion install` and `uninstall` refuse a shell startup file its owner made read-only, exit 2, before they write anything. They used to replace it through a renamed temporary file and keep its read-only mode.
