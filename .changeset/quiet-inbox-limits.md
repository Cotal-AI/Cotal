---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Offline direct-message receipts no longer promise delivery to a session that has ended.
The shared send and chat notice explains that delivery requires the same lifecycle and a surviving inbox. A new session under the same name does not inherit the message.
