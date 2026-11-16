---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Staged updates now retire old update data without removing the active or previous execution generation.
Cleanup runs under the installation's update lock when an update starts, after it succeeds, and when the daemon starts. It skips another account's store and reports removal failures without failing the update.
