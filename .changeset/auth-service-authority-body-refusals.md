---
"@cotal-ai/auth": patch
---

`handleManagerServiceAuthority` now answers a body over 64 KiB with 413 and a body that is not JSON with 400 itself, and answers a JSON `null` body with the same 400 as a body without `idpToken`. Before, those rejections escaped the returned promise, so a host that served the export behind its own `http.createServer` exited on such a request instead of answering it. The auth service's own listeners already answered 413 and 400.
