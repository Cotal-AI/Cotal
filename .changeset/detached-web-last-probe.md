---
"@cotal-ai/web": patch
---

When a detached web dashboard does not become HTTP-ready before the deadline, the timeout error now ends with the outcome of the last readiness probe: the probed `api/meta` URL and the fetch error, the HTTP status, or the space and pid the server answered with. Before, every probe failure was swallowed and the error said only that the dashboard timed out, so a refused connection, a rejected request and a different process on the port all looked the same. The retry cadence and the deadline are unchanged.
