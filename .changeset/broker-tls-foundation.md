---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Serve the broker over TLS: the transport foundation, with the omission cases made unrepresentable.

`serverConfig` and the new `openServerConfig` take a REQUIRED `transport` discriminated union
(`plaintext` | `tls-required { certFile, keyFile }`) instead of an optional TLS field, and
`standaloneConnectOpts` now requires an explicit `tls` boolean with no default. Both are breaking,
and both are deliberate: an optional transport is omitted by default, and the omitted case is the
dangerous one. A client with no TLS requirement still connects to a TLS broker — it upgrades the
same socket after reading the server's unauthenticated `INFO` — so nothing looks wrong until an
on-path attacker forges an `INFO` without `tls_required` and collects the credentials that a NATS
client sends in its `CONNECT` line.

Also in this change:

- `cotal up`'s open (no-auth) mode now renders a config instead of launching from bare CLI flags, so
  no path reaches a listener without naming its transport. Previously a cert/key pair given to an
  open-mode `up` would have been accepted while the broker came up in cleartext.
- `validateTlsMaterial` checks readability, private-key mode, pair match, validity window and
  dial-host SAN before the broker starts, because `nats-server` does not: it reports an expired
  certificate valid, starts, and serves it, and only the client fails.
- `probeServedCert` / `assertServedCertMatches` complete a real STARTTLS upgrade and read back the
  leaf actually being served, so a rotation is proved rather than assumed. Renewing files on disk
  does not reload `nats-server`.
- A durable broker launch policy records the transport so a TLS decision survives `cotal down`, and
  refuses rather than degrading when it cannot be honoured.
- `MeshEntry.tlsRequired` carries TLS-required client intent (never cert paths) through to
  `Connection` and `endpointAuth`, so a CLI-resolved connection inherits the recorded decision.

`allow_non_tls` is never emitted: it is mixed mode, and a client that declines the upgrade is served
in cleartext. `handshake_first` and `verify`/`verify_and_map` are likewise never emitted — mTLS is a
deliberate non-goal, since identity here is JWT/NKey plus the auth callout.

## What this guarantees, and what it does not

**The guarantee.** `cotal up --tls-cert <cert> --tls-key <key>` either serves TLS or refuses to
start. There is no third outcome. The transport is decided once, above every branch in `up`, so the
manifest (`-f`), `--detach`, refresh and restore routes cannot reach a listener without naming it;
each route re-checks the certificate against the host clients will actually dial. A running broker
cannot change its transport, so passing the flags to an already-running mesh is refused rather than
answered with a success line. The decision is recorded, so a later bare `cotal up` after a
`cotal down` keeps serving TLS instead of silently reverting to cleartext.

**A direct `CotalEndpoint` construction still defaults to plaintext.** `EndpointOptions.tls` remains
optional and absent still means "no TLS required". If you build an endpoint yourself rather than
going through `cotal up` or a resolved mesh record, you must pass `tls: true`; nothing will tell you
otherwise, and the connection will succeed either way against a TLS broker because a NATS client
upgrades the same socket once it reads the server's `INFO`. Making that field required is a tracked
follow-up. It is called out here because "Cotal supports TLS" is not something you should be able to
believe while your own client is connecting without requiring it.

**Processes that connect without requiring TLS.** The broker refuses cleartext, so these do not
connect in the clear against it. What they lack is their own requirement, which is the fence that
protects them against a stripped or forged `INFO`:

- the mesh manager (`manager.ts`, including its raw `connect` for credential probing)
- the user-auth service
- the membership feed
- the web dashboard's server-side client
- `waitForDeliveryLease` (`packages/core/src/lease.ts`), which builds its own `connect` options
  rather than going through `standaloneConnectOpts` and so has no TLS path at all

The delivery daemon is strict on all three of its dials, including the every-two-seconds reachability
poll that re-presents its standing credential for the life of the process.

**Also not included:** the `cotals://` handout from `up`, first enablement being restart-only (a
reload leaves established plaintext sessions alive), a rotation command, and `tls://` as a *server*
scheme enforcing anything (it is cosmetic at the client: nats.js connects plaintext to `tls://host`
with empty options, and only the explicit `tls` option refuses).

Operators using a private CA need `NODE_EXTRA_CA_CERTS`, because `EndpointOptions.tls` is a boolean
and cannot carry a CA file. The private-key permission check is POSIX-only.
