---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

A broker refusal of an endpoint call no longer tells a caller that was just granted that it holds no grant. The broker fixes a connection's permissions when it authenticates, so a grant made while the caller is connected reaches only its next connection. Every refusal (describe, call, cast and liveness probe) now says either no grant covers the call, or it was granted after the connection authenticated and the caller should reconnect and retry. `cotal service-endpoint grant` also says that a connection the grantee opened before the grant must reconnect before it can use the new commands.
