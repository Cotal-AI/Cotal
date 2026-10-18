---
"@cotal-ai/auth": patch
---

`cotal agent-bearer` and the remote agent-provisioning request now refuse a successful answer whose body is not JSON, such as a gateway's HTML page, naming the HTTP status and saying the body could not be read as JSON. Before, `cotal agent-bearer` reported that the auth service returned no token and blamed a stale build, and provisioning returned an empty object to `cotal spawn` as if the endpoint had sent it. A JSON answer, an empty JSON object included, and every refused status are handled as before. The response body is never quoted.
