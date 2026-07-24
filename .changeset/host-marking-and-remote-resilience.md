---
"@cotal-ai/connector-core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
"@cotal-ai/manager": patch
---

Report which machine an agent runs on, and fix three defects that only appear once a mesh spans hosts.

**`meta.host` on the agent card.** A mesh can span machines: a manager on another box launches
agents into its own host, so "where is this agent actually running" was unanswerable from the
roster. Each session now publishes its own `os.hostname()` as `meta.host`, overlaid last like
`meta.connector` so an agent file cannot claim a host it is not on. It is advisory display
metadata only, never an authorization or routing input, and the dashboard renders it with no
change (unknown meta keys already display generically). `SPEC.md` records it alongside the other
reserved `meta` keys.

**`cotal up --host <addr>` killed the broker it had just started.** The bind address and the
broker URL were tracked independently, so `--host` bound one address while the readiness probe
still used the loopback default. The probe found nothing, timed out, and the caller SIGTERM'd a
broker that had started correctly, which made `--host` alone impossible to use. The two are now
reconciled: with no explicit `--server`, the URL is derived from the host; a contradicting pair is
refused with one sentence instead of starting something unreachable; and wildcard binds
(`0.0.0.0`, `::`) correctly keep a dialable loopback URL rather than advertising the wildcard. The
manifest path (`broker.host` without `broker.servers`) had the same defect and shares the fix.

**One slow probe silently unregistered a live mesh.** `pruneStaleMeshes` deleted any registry
entry that failed a single reachability check whose budget is 1s, which a healthy broker across a
slow or jittery link misses routinely. Deletion is destructive and, for a mesh this machine did
not start, unrecoverable, since only `cotal up` writes registry records. A first failure now only
makes an entry a candidate; it is pruned only if a second, longer probe also fails. A genuinely
dead mesh still prunes.

**`cotal attach` could not reach a manager on another machine.** The manager's attach face bound a
hardcoded `127.0.0.1` and advertised that same literal in the URL it handed back, so a remote
operator dialed their own loopback and got `ECONNREFUSED`. It now binds and advertises the host the
mesh broker is on: a loopback mesh keeps a loopback-only endpoint, and a mesh the operator exposed
gets an attach face reachable from the same places. Because that face can now leave the box, and it
carries terminal read and write for every managed agent plus the roster and live feed, the entire
surface is credentialed with a per-manager token: the CLI receives it inside the attach URL over the
already-authenticated control plane, a browser gets it once via `?t=` and then a same-origin
HttpOnly cookie, and every route and the WebSocket upgrade answer `401` without it. There is no
unauthenticated path and no bind-dependent branch.

**A timed-out request killed the whole dashboard.** `cotal web` passed an async listener to
`createServer`, so a rejection inside any route (for example a JetStream call timing out against a
slow broker) became an unhandled rejection and took the process down on the first slow request.
The dashboard is a read-only observer: a failing route now returns 500 and the server stays up.
