---
"@cotal-ai/core": patch
---

Internal refactor: the endpoint's option validation moves out of the `CotalEndpoint` constructor into two functions beside `EndpointOptions`, one for the principal and credential and one for the connection and delivery settings. No behaviour change.
