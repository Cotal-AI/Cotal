---
"@cotal-ai/lang": minor
---

A workflow run is held to a 512 MB heap, and a program may not build an array, string or record over a fixed size.

Each run's engine thread is created with fixed heap limits instead of inheriting the host process's own. Everything the run holds counts, its journal included. A run that reaches the limit is recorded failed with a message naming it, and the process carries on. A thread whose limit a V8 heap flag on the process replaced refuses to run any program.

One array may hold at most 1,000,000 elements, one string at most 4,000,000 UTF-16 units, and one record built by `json.parse`, `merge` or a record literal at most 250,000 fields. A builtin, method, spread, template, `+` or index write that would build a larger value raises L4016 naming the operation, before the value is built. A program that relied on larger values now fails at that call.
