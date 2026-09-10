---
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

Stop republishing tool-call arguments and results onto `events.<owner>.<actor>`. The durable emitter drops `TOOL_CALL_ARGS` and `TOOL_CALL_RESULT` before the write-ahead log, and refuses to republish a frozen pre-fix frame that still carries them. Observers lose that tool output; that is the boundary. Tool start and end, text, and reasoning still go out.
