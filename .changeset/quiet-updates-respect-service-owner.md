---
"cotal-ai": patch
---

CLI updates leave another installation's background service and hosted Managers running without fencing them. The owned daemon releases abandoned update fences only after the recorded updater process lifetime has ended, while living callers keep their admission fences.
