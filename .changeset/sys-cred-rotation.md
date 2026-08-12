---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/delivery": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

Renew the `$SYS` credentials without tearing the space down.

`membership-observer.creds` and `connection-evictor.creds` carry a 30-day expiry and are signed by
the system-account seed, which is never persisted, so nothing re-signs them in place. The only
repair the tooling named was "`cotal down` then a fresh `cotal up`", and that did nothing: `up`
mints the pair only on the branch that *creates* the trust record, so re-upping a provisioned space
reused the same expired files and reported success. A long-running mesh therefore lost its
membership feed and live connection eviction every 30 days with no supported way back.

`cotal up --rotate-sys` is that way back. It issues a new system account under the same broker
operator, mints both `$SYS` creds against it, and renders the broker config from the rotated record,
so the broker it starts is the one that trusts them. The data account, the account signing key,
every agent credential minted from it and the JetStream store are untouched; what dies is the
retired system account, on every broker that loads the rotated config. It is refused wherever the
on-disk material and the broker could end up on different generations: a running mesh; an open mesh,
whether that comes from `--open` or from `broker.auth: false` in a manifest; `--restore`; an
unfinished restore or resume attempt on the root, including one a bare `cotal up` would recover,
since those paths can adopt a live listener and return without booting a broker; and a root hosting
more than one space, because the system account lives in the shared broker record and the rotation is
therefore broker-wide. `rotateSystemCreds` is exported from `@cotal-ai/workspace` for hosted
compositions and carries the multi-tenant guard itself rather than at the CLI flag.

A rotation requires every broker for the root to be STOPPED, and that is now proven rather than
inferred from the address being asked for: a live `nats.pid`, an unreadable one, or any recorded mesh
for this root still answering all refuse. Without that proof a lost registry row was enough to bypass
the running-mesh refusal entirely — `up` would find the port busy, pick a free one, rotate, and leave
the old broker serving the retired config while a second one ran against the same JetStream store.

Two consequences the tooling now states rather than leaving to be discovered. The retirement is
config-load-bound, so a stale broker still running the previous config keeps honouring the old creds
until it is stopped. And a full backup binds to the trust chain it was taken against, which includes
the operator JWT and the system account, so every full artifact taken before a rotation refuses to
restore afterwards: the rotation says so as it happens, and `cotal up --restore` names the drift when
the data account still matches. The commit is a trust-record write plus two credential writes, so an
interrupted rotation leaves the record ahead of the creds; that split is detected rather than
silent. One shared check compares each `$SYS` cred's issuer against the persisted record, and it
runs on every auth-mesh boot as well as in `cotal doctor auth`, so the state cannot pass unremarked
by a mesh that simply never runs the doctor. The boot REFUSES rather than warning: a warning becomes an unread log line
under `--detach`'s success output, and live connection eviction rides the same credential pair, so
booting would silently downgrade revocation to deny-new for the life of the mesh. The delivery daemon, which never
loads the signer and so cannot read the record, compares the two creds against each other instead.

Diagnosis now names the cause instead of the symptom. An expired observer cred used to surface as a
bare "Authorization Violation" in the delivery log and, one layer up, as a `membership-rw` adoption
refused with "membership feed is not running" — neither of which mentions a credential. The daemon
checks the observer's own expiry before connecting and reports it, carries that reason into the
adoption reply, and the manager warns on every renewal pass from the 75% point onward rather than
letting the mesh discover the expiry at the horizon. `cotal doctor auth`, `evictPrincipal`,
`planeConnLiveness` and the two mint errors now print the repair that works.
