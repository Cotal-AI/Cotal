---
"@cotal-ai/connector-core": patch
---

`cotal_inbox` now delivers a message larger than one response in parts. Once no smaller mail is waiting, each call carries the next part, a peek shows the current part without moving on, and the message is cleared only after its last part goes out. This holds for focus recall too: an oversized channel message recalled in focus is read in parts, and recall does not move past it before its last part. The read position survives a reconnect; a process restart starts the message again from its first part. Before this, such a message was named but could never be read.
