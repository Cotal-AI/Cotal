---
"@cotal-ai/auth": patch
---

A manager-authority answer whose body is not JSON now fails the request with an error that names the operation, the endpoint and the HTTP status. Before, the client replaced such a body with an empty object, so a 200 answer resolved as an empty result the endpoint never sent, and a refusal read the same as a refusal with an empty JSON body.
