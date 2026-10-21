---
"@cotal-ai/cli": patch
---

`cotal up --runtime <name>` refuses a runtime with no installed provider, or one whose provider does not answer, as `DEPENDENCY_UNAVAILABLE` (exit 2) before anything is written or started. For a known runtime the remedy names the `cotal ext add <pkg>` to run. A controller stack used to start its broker and delivery first, then report only that the manager exited before readiness.
