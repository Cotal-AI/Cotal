---
"@cotal-ai/auth": patch
---

The IdP user JWT is reused in memory for at most a minute per (IdP, session), never past its own `exp` minus a margin, and concurrent callers share one `/token` request. A manager hosting many runs posted one `/token` per authority call and tripped the IdP's per-source rate limit, so unrelated spawns and reads failed with a bare HTTP 429. Failures are never held, a 401 keeps its sign-in-again message, and IdP-side revocation now bites within a minute instead of at the next call. The JWT is still never written to disk.
