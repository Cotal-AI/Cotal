---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Staged updates now remove abandoned staging folders and finished transactions while keeping all execution generations.
Cleanup runs under the installation's update lock when an update starts, after it succeeds, and when the daemon starts. It skips another account's store and reports removal failures without failing the update.
