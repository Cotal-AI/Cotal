---
"@cotal-ai/cli": patch
---

`cotal completion install` no longer replaces a shell startup file its owner made read-only. It writes its stub, leaves the startup file unchanged, and fails, exit 5, naming the line to add yourself. `cotal completion uninstall` refuses such a file, exit 2, and changes nothing.
