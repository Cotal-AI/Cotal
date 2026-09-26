---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Gate the event plane on the typed spawn contract behind the caller's admin tier on a user mesh (#373): a non-admin caller asking for `events: true` is refused before anything is provisioned, an omitted bit is served unarmed with a notice in the reply, and a space whose policy requires events refuses non-admin spawns outright. The CLI's detached spawn now sends the events bit only when the operator chose it and prints the reply's notice.
