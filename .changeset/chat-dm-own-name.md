---
"@cotal-ai/cli": patch
---

A `chat` direct message to the session's own name, when no other participant carries it, refuses with `USAGE_INVALID` saying it is the session's own name. It used to say no peer had that name.
