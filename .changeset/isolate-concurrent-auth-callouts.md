---
"@cotal-ai/auth": minor
---

Process auth callouts with bounded concurrency so one slow authority check or issuance recorder does not block every other connection. Embedding hooks must support overlapping calls for different connections; each response still awaits its own authority and issuance checks.
