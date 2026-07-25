---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Make `cotal attach` reach a manager on another machine, and credential that endpoint properly.

The manager's attach face bound a hardcoded `127.0.0.1` and advertised that same literal in the URL
it handed back over the control plane, so a remote operator dialed their own loopback and got
`ECONNREFUSED`. Attach only ever worked when the manager happened to be on the same box.

**Where it binds is now an explicit decision.** The endpoint takes a bind address, still loopback by
default, so a bare `cotal supervise` and an embedded `Manager` keep exactly the machine-local
endpoint they have always had. `cotal up` passes the address it bound the broker to (via a new
`supervise --console-host`), which is what makes a remote attach work. The broker's *dial* address is
deliberately not reused as the *bind* address: a manager may supervise a broker on another host and
cannot bind that address at all, and a failover list's first entry need not be the server actually
selected. Where the manager can only name loopback — a wildcard bind — the client substitutes the
broker address its own control connection reached, so `up --host 0.0.0.0` works too instead of
silently handing back an unreachable URL.

**The endpoint is now credentialed, in two tiers.** It carries terminal read and write for every
managed agent, plus the managed roster and the live mesh feed, so once it can leave the machine
"unauthenticated but loopback-only" stops being a safe position. A mesh caller receives a **ticket**
bound to the one agent the manager just authorized, single-use and short-lived; this is what makes
the existing per-agent owner/admin check real, since a manager-wide token would let a caller
legitimately authorized for its own agent swap the path and take over another owner's terminal. The
**console token** is the operator's own, reaches every agent because the console drives all of them,
and is printed solely to the manager's own output. The roster, feed, and PTY stream answer `401`
without a credential; the static console shell stays open, since it describes no agent.

Credentials never ride a cookie: cookies are host-scoped rather than port-scoped, so one set here
would be sent to every other HTTP service on the same host and would collide between two managers on
one box. The console URL carries its token in the fragment, which a browser never sends to a server,
and the console page is served `no-store` with `Referrer-Policy: no-referrer`.

Also fixes an IPv6 regression in the same area: `URL.hostname` returns an IPv6 literal bracketed
(`[::1]`), which `listen()` treats as a DNS name and fails `ENOTFOUND`. Brackets are stripped for the
bind and restored for the advertised URL. An address this host does not own now fails with the
address named and the resolutions spelled out, rather than a bare errno from deep inside startup.

Covered by a new `smoke:attach-auth` in the CI gate (38 checks), including the cross-agent path-swap
that the first design allowed.
