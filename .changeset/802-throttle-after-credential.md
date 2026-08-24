---
"@cotal-ai/auth": patch
---

The public exchange face no longer refuses a request that would have succeeded. The
refused-exchange throttle was enforced before the request body was read, so a full bucket denied
every request from that peer key, including callers holding a valid IdP JWT or actor token. On
the public face the default peer key is the socket address, so in the reverse-proxy topology the
docs recommend, every client shares one bucket and thirty unauthenticated POSTs denied the
public mint path for a rolling minute. The gate is now evaluated up front but enforced only on a
genuine credential failure, so a throttled peer still mints with a valid credential while a
failed exchange is answered 429 rather than its specific reason.
