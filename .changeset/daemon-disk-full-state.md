---
"cotal-ai": patch
"@cotal-ai/workspace": patch
---

`cotal daemon status` shows a Disk row and reports `diskFull: true` in JSON when the background service observes a write fail for lack of space. The status clears when the service can write to the affected directories again, without restarting. A failed computer name or update settings save leaves the previous record intact. A hosted Manager reports when a full disk stops its log writes and clears the log warning on its next successful append.
