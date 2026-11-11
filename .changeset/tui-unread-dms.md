---
"@cotal-ai/workspace": patch
---

The terminal app can keep which direct messages you read, so an unread one stays listed after a restart and a read one stays gone.

`readMarks()` and `markRead()` from `@cotal-ai/workspace/chat` read and record message ids in a private `read.json` beside a space's remembered chat sessions, which keeps the newest 1000 and takes a lock for each write. `forgetChatSessions()`, and so `cotal space forget`, removes it with the sessions.
