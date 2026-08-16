---
"@cotal-ai/web": minor
---

feat(web)!: authenticate the console's HTTP surface with a single-use launch link

The dashboard's loopback surface authenticated nobody — `req.headers` was read zero times. Loopback
keeps other hosts out; it never kept out another process on the same machine, nor a page in the
operator's own browser issuing requests to `http://127.0.0.1:7799`, and what that reached was the
whole mesh read path plus a channel-delete.

`cotal web` now mints a one-time launch token per process and prints it in the URL it opens. The
token is exchanged exactly once for an `HttpOnly; SameSite=Strict` session cookie, and the exchange
redirects so the spent secret leaves the address bar. Every route runs behind the gate. Refusals name
which condition failed — `unauthenticated`, `launch-token-already-used`, `cross-origin` — instead of
returning an empty success, and the origin is checked before the session so a cross-site request is
never reported as merely unauthenticated.

Breaking for anyone driving the dashboard's HTTP endpoints directly: requests now need the session
cookie, and the printed URL is single-use. `--detach` is unaffected in use — the child writes a
`0600` session file after binding and the parent authenticates its readiness poll with a separate
nonce.
