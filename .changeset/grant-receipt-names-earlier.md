---
"@cotal-ai/auth": patch
---

An actor grant receipt now names the earlier grant as none, the same fields or replaced, and says when its lifecycle was retired. A re-grant with the same fields is titled `Actor grant stored unchanged`; JSON carries `previous` and `previousLifecycleRetired`. Before, every grant read "Actor grant stored", so a repeat could not be told from a change.
