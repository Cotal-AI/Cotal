---
"@cotal-ai/core": patch
---

Stopping an endpoint now ends its principal-route serves, and a principal-route call now waits for its own reply instead of failing on a message that is not it.

`CotalEndpoint.stop()` ends every serve that `servePrincipal` started: a `ready` still waiting rejects, and the handlers in flight finish before the connection closes. A caller drops a stored message on its reply read, such as one an agent asks a Direct Get to deliver on the caller's sentinel, and keeps waiting past a message from another head for the reply the addressed process derives. The presence `prompts.seq` never goes back under one runtime id: the process keeps the highest it used across serves and endpoint objects, `setPromptsPresence` refuses a lower value with a RangeError, and the new `CotalEndpoint.nextPromptsSeq()` hands out the next one. A second `servePrincipal` of one endpoint for one lifecycle in a process now throws, because both would answer the same subject.
