---
"@cotal-ai/cli": patch
---

Version reports now direct a configuration home with older first-party extensions to `cotal update` instead of reinstalling the shared CLI.

Commands that need built-ins already reconcile that home's connectors before using them. Version inspection remains read-only, and interrupted-update recovery keeps its existing guidance.
