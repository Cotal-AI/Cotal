---
"@cotal-ai/connector-codex": patch
---

The codex host persists the event plane's bind boundary into the log as soon as the start
succeeds, instead of waiting for the emitter's first read. A host that dies between a successful
bind and its first pump now resumes from the recorded boundary instead of taking a fresh one at
the file's later end, so it no longer drops what the thread wrote in between.
