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

Not yet included: the `up` cert/key flags, strictness for the manager, delivery, membership, the web
server-side client and the auth service, the `cotals://` handout, restart-only enablement and the
rotation command.
