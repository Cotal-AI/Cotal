---
"@cotal-ai/connector-jcode": patch
---

The Jcode connector accepts `cotal spawn --resume <id>`. It forks the named session from the operator's Jcode home into the seat's private home before the seat's instance starts: a new session id whose parent is the source, carrying the source's messages, compaction state, system prompt and model. The source files are only read. A session with no readable transcript, or with a message, content block or compaction state that does not match Jcode's schema, is refused before the seat launches, naming the field. A live source is read until two reads agree and its journal is newer than its snapshot, so a checkpoint caught mid-way is neither lost nor applied twice. A seat relaunched under the same name continues its fork without reading the source again, and a first launch that fails after forking still briefs the seat on its next launch.
