---
"@cotal-ai/workspace": patch
---

Publishing a pid record over a pidfile that exists but cannot be read now throws an error naming the pidfile before anything is renamed. It used to read that pidfile as a first start, so the bridge pin dropped the old record's line and the publish replaced the unreadable pidfile without reporting the read error.
