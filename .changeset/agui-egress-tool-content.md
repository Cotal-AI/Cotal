---
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

Stop republishing tool-call arguments and results onto `events.<owner>.<actor>`. The durable emitter drops `TOOL_CALL_ARGS` and `TOOL_CALL_RESULT` before the write-ahead log, and refuses to republish a frozen pre-fix frame that still carries them. A frozen frame whose event list cannot be read is withheld too, and the emitter halts by name rather than publishing bytes it could not inspect onto a channel with a different read ACL. An empty event list counts as unreadable rather than as nothing to object to, since no shipped writer can produce one. Observers lose that tool output; that is the boundary. Tool start and end, text, and reasoning still go out.
