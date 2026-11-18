---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A workflow run is held to a 512 MB heap, and a program may not build an array, string or record over a fixed size.

Each run's engine thread is created with fixed heap limits instead of inheriting the host process's own. Everything the run holds counts, its journal included. A run that reaches the limit is recorded failed with a message naming it, and the process carries on. A thread whose limit a V8 heap flag on the process raised refuses to run any program, and the run is released so a correctly started host can take it back; a flag that lowers the limit is accepted.

One array may hold at most 1,000,000 elements, one string at most 4,000,000 UTF-16 units, and one record at most 250,000 fields. A builtin, method, spread, rest, template, `+` or index write that would build a larger value raises L4016 naming the operation, before the value is built; case mapping is checked on its result. A count, length or position argument to a builtin or method must now be a number, and a string or other value there raises L4018. A program that relied on larger values or on a converted count now fails at that call, including on resume.
