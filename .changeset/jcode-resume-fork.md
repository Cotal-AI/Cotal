---
"@cotal-ai/connector-jcode": patch
---

The Jcode connector accepts `cotal spawn --resume <id>`. It forks the named session from the operator's Jcode home into the seat's private home before the seat's instance starts: a new session id whose parent is the source, carrying the source's messages, compaction state, system prompt and model. The source files are only read. A session with no readable transcript is refused before the seat launches, and a seat relaunched under the same name continues its fork.
