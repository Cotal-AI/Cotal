---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A workflow run is held to a 512 MB heap, a program may not build an array, string or record over a fixed size, and what leaves a run has a size bound.

Each run's engine thread is created with fixed heap limits instead of inheriting the host process's own. Everything the run holds counts, its journal included. A run that reaches the limit is recorded failed with a message naming it, and the process carries on. A thread whose limit a V8 heap flag on the process raised refuses to run any program, and the run is recorded released; `cotal run resume <runId> --local` from a host started without the flag continues it. A flag that lowers the limit is accepted.

One array may hold at most 1,000,000 elements, one string at most 4,000,000 UTF-16 units, and one record at most 250,000 fields, a repeated key counting once. A builtin, method, spread, rest, template, `+`, `+=`, `sum` or member write that would build a larger value raises L4016 naming the operation, before the value is built; case mapping is checked on its result. A count, length or position argument is converted as before, and the converted number is what the bound is checked against. Destructuring a string takes only the elements its pattern names.

A log line, an effect's arguments and a run's returned value may take at most 8,004,096 bytes out of the run's thread, each reference to a string counted in full, and raise L4016 past it. A run that logs faster than its host writes waits for the host, and a printed log line is cut at 16,384 characters with its length named.

A primitive's arguments can no longer be spread (`sleep(...xs)`): the validator refuses it with L1029. The tree-walker never ran such a call.

A program that relied on larger values now fails at that call, including on resume.
