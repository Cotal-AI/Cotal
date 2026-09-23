---
"@cotal-ai/connector-jcode": patch
---

Refuse a jcode seat whose stored `sessions/` directory exists but cannot be written before the
harness is asked for a session. The harness accepts `create_session` on such a directory and dies
only while persisting the session during the first turn, which rendered as `startup failed
(unknown)`. The refusal carries the fixed `sessions_unwritable` startup code with the directory
path and the errno, and never repairs or widens the permissions itself. A missing `sessions/`
directory stays a first launch. Refs #1538.
