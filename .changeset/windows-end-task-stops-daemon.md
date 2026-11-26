---
"cotal-ai": patch
---

Ending the Windows desktop app's background service in Task Scheduler now stops it. Before, it stopped only the small launcher and left the service itself running, so the app showed nothing wrong and the files stayed in use.
