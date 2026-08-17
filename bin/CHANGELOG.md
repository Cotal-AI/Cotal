# cotal-ai

## 0.20.0

### Patch Changes

- Updated dependencies [4743594]
  - @cotal-ai/cli@0.20.0
  - @cotal-ai/core@0.20.0
  - @cotal-ai/workspace@0.20.0
  - @cotal-ai/manager@0.20.0
  - @cotal-ai/delivery@0.20.0
  - @cotal-ai/connector-core@0.20.0
  - @cotal-ai/auth@0.20.0

## 0.19.0

### Minor Changes

- a1bc784: Display an agent event frame, and separate event channels from chat.

  An `ag-ui.frame` part carries no text part by design, so every surface that renders a message as
  flat text drew one as `[unrenderable part kind "ag-ui.frame"]`. A renderer now folds a frame's
  events into readable lines: streamed text and reasoning deltas accumulate into one line rather than
  one line each, a tool call reports its name, its arguments and its result, and a stream that ended
  without its terminator is flushed and marked truncated instead of being dropped. An event type this
  build does not know is named rather than skipped, because a skipped event is a hole in a transcript
  that still looks complete. It registers through the part-renderer seam, so the standard resolves it
  by the part's own kind and never learns what the vocabulary means.

  The renderer is loaded by the composition root rather than by a connector. Connectors are removable
  extensions materialized on demand, and no surface that renders imports one, so a provider that
  registered only inside a connector would be absent from every process that draws.

  The event channel's name and its classifier move into the standard, beside the frame's identity.
  Both are things a reader needs in order to recognise an agent's stream without knowing which adapter
  produced it, and the two surfaces that most need to classify cannot reach an extension package at
  all. The constructor is re-exported from its former home, so no caller changes.

  The classifier is now a derivation rather than a prefix test, and the two disagree on names a real
  mesh produces. Nothing reserves the `events.` prefix, so a channel a human created and talks on
  answered yes to "does this start with `events.`" and was swept out of the chat pane it was sent to.
  A name that does not resolve to a principal is no longer treated as machine traffic, which returns
  those channels to the view, and leaves a malformed publisher visible rather than hidden. The
  collision is narrowed rather than closed: a chat channel whose remainder is itself principal shaped
  is still indistinguishable from an agent's stream, and closing that means reserving the prefix on
  the wire.

  The console keeps event channels out of the channel strip and out of the history prefill. The order
  matters more than the result: the channel list carries one entry per retained subject, so filtering
  after the fetch would read history for every event channel and discard it, which is unbounded work
  to display nothing. Live rows are marked rather than dropped, because hiding them would delete the
  only traffic this change taught the console to draw.

  The dashboard gains the same rendering through a per-kind lookup, so its dispatcher stays ignorant
  of every kind anyone teaches it. A renderer that throws, returns a non-string, or shares a name with
  an inherited object method is reported by name instead of blanking the body. The browser cannot
  import the shared renderer, so the two implementations are held together by an executable
  equivalence check rather than by intent.

  The example harness records a message through the shared renderer instead of keeping only its text
  parts, so a message whose content is not text is no longer written to the transcript as an empty
  string and scored as an agent that said nothing.

  No connector emits a frame yet, and no transcript mirror is removed. Display lands first on purpose:
  a cutover shipped before a renderer would replace a readable mirror with a part every surface shows
  as a marker.

### Patch Changes

- 758e1e3: Pin `json-canonicalize` exactly, so a published install cannot resolve a broken tarball.

  `json-canonicalize@2.0.1` was published without the `bundles/` directory its own `package.json`
  `main` points at. A `^2.0.0` range therefore resolves, on any fresh install, to a package that
  cannot be imported: `cotal --version` crashes with `ERR_MODULE_NOT_FOUND` before printing
  anything.

  The repo never saw it. A lockfile pins 2.0.0 and CI stayed green throughout; a published package
  carries no lockfile, so npm re-resolves every range at install time and users got a version CI had
  never exercised. That gap between what CI resolves and what an install resolves is the actual
  defect this fixes.

  Both ranges are now exact, and `smoke:dep-pins` keeps them that way: it fails if either floats
  back to a range, and fails if its quarantine list stops matching any declared dependency, so a
  list that has quietly stopped applying cannot read as a list that holds.

  Stated as a limit rather than left implied: the new cell proves the range is exact, not that the
  pinned version is installable. Only installing the packed tarball against the live registry proves
  that, which is `smoke:seed-tarball:live` - and that suite sits outside `smoke:ci`, so the
  instrument that would have caught this incident exists and does not run. Wiring it into the gate
  is a separate decision about live-network tests in CI, not something this change makes quietly.

- c3dd6a5: fix(web): route on the channel the broker policed, not the one the publisher claimed

  The browser dashboard decided which channel a message belonged to by reading `msg.channel` off the
  payload. That field is written by the publisher, and the broker polices **subjects**, not payload
  fields, so a sender could put any channel name in a message body and have the dashboard file it
  into that channel's transcript, including a channel the sender had no permission to publish to.

  The verified channel was already available and was being discarded: the observer parses the subject
  to recover the authenticated sender, then dropped the rest of it. Routing now uses the channel
  derived from the subject the broker actually enforced. Where no authoritative channel exists
  (direct messages and anycast carry none), the publisher's claim is cleared rather than trusted, so a
  forged value cannot survive into a transcript, a channel list, or an unread badge.

  Two rendering fixes ride along, because a message whose content vanishes is the same class of defect
  one surface over. A part kind the surface has no renderer for previously produced an empty body, so
  a message with content displayed as a blank line; it now renders a marker naming the kind, and a
  part carrying data keeps that data instead of having it replaced by the marker. A surface that
  prints a marker while dropping the content looks like successful rendering, which is precisely the
  failure being removed. The two dashboard surfaces now share one parts renderer so they cannot drift
  apart on what a part looks like; that drift is how the original defect reached both of them.

  **Limits worth stating.** The new suites drive the served JavaScript directly: they execute the
  shipped handler and backfill functions and assert message content and destination, but no cell opens
  a browser or asserts rendered HTML, so this proves the routing and the renderer's return value, not
  that either survives to the pixels. Rendering of external observer/UI event frames, and the filter
  that selects them, are separate work and are untouched here. The dashboard's loopback HTTP surface
  is unauthenticated and this change does not alter that; a failed membership read still renders as a
  successful empty result, so a viewer cannot distinguish "nobody is subscribed" from "the read
  failed". Both predate this change and are named so the routing fix is not mistaken for making that
  surface safe.

- 0e44e37: fix(web): tell the browser a membership read failed instead of serving it as empty

  The dashboard's `/api/membership` route answered a failed read with `{asOf: undefined, members: []}`
  and a 200. `JSON.stringify` drops a key whose value is `undefined`, so those bytes are
  `{"members":[]}`, byte-identical to a successful read of a space where nobody is subscribed. The
  graph then reported the feed as `membership: traffic-only`, which asserts that the mesh publishes no
  membership feed, when the truth was that the read did not answer.

  A failed read now carries a 503 and names its condition; the two server-sent-event paths emit a
  named event instead of swallowing the rejection; and the page stops manufacturing an empty snapshot
  from a failed fetch or a non-200. The freshness pill gains an `unreadable` state, tested before
  `traffic-only` so a refusal cannot borrow that phrase.

- Updated dependencies [48c6631]
- Updated dependencies [ae2f31b]
- Updated dependencies [10d9cd6]
- Updated dependencies [a1bc784]
- Updated dependencies [a7267b3]
- Updated dependencies [ce1c248]
- Updated dependencies [5e95736]
- Updated dependencies [19931dd]
- Updated dependencies [6074c26]
- Updated dependencies [24687a3]
- Updated dependencies [17f14be]
- Updated dependencies [87c4130]
- Updated dependencies [cb9e1ad]
- Updated dependencies [c038730]
- Updated dependencies [007a17b]
- Updated dependencies [eae512e]
- Updated dependencies [7f83b8c]
- Updated dependencies [82dd701]
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [12f2df8]
- Updated dependencies [8572a5d]
- Updated dependencies [4e8d776]
  - @cotal-ai/core@0.19.0
  - @cotal-ai/connector-core@0.19.0
  - @cotal-ai/cli@0.19.0
  - @cotal-ai/workspace@0.19.0
  - @cotal-ai/manager@0.19.0
  - @cotal-ai/delivery@0.19.0
  - @cotal-ai/auth@0.19.0

## 0.18.0

### Minor Changes

- 665b378: Gate which broker addresses a mesh may be registered at, and make the unsafe one an explicit choice.

  Registering a mesh is how a machine starts sending agent credentials to a broker it does not run,
  and nothing here can require an encrypted connection yet. NATS announces itself in plaintext
  before anyone authenticates, so an attacker on the path can pose as the broker and read the
  credential straight out of the connect; a `tls://` URL does not prevent it, because it is the
  connect options rather than the scheme that make the client insist on TLS.

  `cotal meshes add` therefore gates on the address. Loopback literals (`127.0.0.0/8`, `::1`) are
  permitted because nothing leaves the machine. Private-overlay literals (`100.64.0.0/10`,
  `fd7a:115c:a1e0::/48`) require `--allow-unencrypted-overlay`, an explicit acceptance that is
  recorded on the mesh entry: they ride an encrypted tunnel only while that tunnel is actually up,
  and with it down the range is ordinary carrier-grade NAT that hostile routing can answer. A
  printed warning was not enough — stderr is not read by scripts, and it was not persisted, so
  nothing repeated it at the dials that followed. Everything else is refused, including ordinary
  private ranges such as `10.x` and `192.168.x` — a café network is private too, and private is not
  the same as yours.

  Registering an authenticated mesh also copies that mesh's `.cotal/auth`, which carries the space's
  account **signing seed**: a machine holding it can mint any identity in the space until the signing
  key is rotated and every credential re-minted. The docs and the guided form now say so where the
  operator reads them, and `cotal mint` alone does not substitute (registration needs signing
  material that composes).

  **Scope, stated precisely so this is not read as more.** This gates NEW REGISTRATIONS, and only
  those. It is not a client-side dial fence: a record written before this change, or a `--server`
  override, reaches the broker through the ordinary connect path without consulting it. Calling the
  join path "protected" or "made safe" would be wrong. Fencing the credential-bearing dial itself
  is separate work.

  Hostnames are refused as well, even ones that resolve somewhere permitted, because otherwise
  whoever answers the lookup decides which machine receives the credentials. The check runs before
  `--force`, which exists for a mesh that is temporarily down and never waives it.

### Patch Changes

- Updated dependencies [0ab9b4d]
- Updated dependencies [208ad1f]
- Updated dependencies [b519e73]
- Updated dependencies [665b378]
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0
  - @cotal-ai/auth@0.18.0
  - @cotal-ai/manager@0.18.0
  - @cotal-ai/connector-core@0.18.0
  - @cotal-ai/delivery@0.18.0
  - @cotal-ai/cli@0.18.0
  - @cotal-ai/workspace@0.18.0

## 0.17.0

### Minor Changes

- 975cad1: Give each space an artifact object store, with a real size limit.

  The `artifact` message part references bytes that live outside the message; this is where they live.
  Every space now gets a JetStream Object Store alongside its other streams, created by the same setup
  that creates them and removed by the same teardown.

  It carries an explicit 4 GiB cap, which is the point rather than a detail. A fresh object store ships
  unlimited, and a space's account is provisioned with unlimited disk, so "the account limit bounds it"
  would have bounded nothing — artifacts could grow until the disk did, starving the chat and delivery
  streams sharing it. Reaching the cap refuses the write instead of evicting older objects, so a
  reference published yesterday cannot quietly stop resolving.

  A space resource has to be listed in five separate places — created, deleted, granted, enumerated for
  backup, and recreated on restore — and being in four of them is the failure that reads as correct.
  Excluding the store from backups does not mean restore skips it: restore rebuilds every excluded
  resource and then asserts each one exists, so a store left out would fail a restore rather than
  quietly come back missing. The store is excluded under its own class rather than borrowed from an
  existing one, because artifact bytes are neither transient, derived, nor a lease, and calling them
  derived would suggest something could recompute them.

  Two smokes join the gate. One proves the store against a real broker by enumerating what the broker
  actually holds — created, matching the inventory exactly, carrying its cap, and gone after teardown —
  because create and delete are claims about a broker and cannot be checked any other way. The second
  was already in the repository, asserting the stream inventory, and no script had ever run it; it is
  now registered and gated, and it fails correctly on this change.

- c76a49d: Add the `artifact` message part: a reference to bytes too large to send.

  Every Cotal message rides one NATS message under the broker's maximum payload, so moving a file
  between agents has meant pasting bytes into chat until it breaks, or sharing a filesystem path that
  stops working the moment two agents are not on the same machine. SPEC §5 reserved the answer; this
  defines it. A message can now carry `{ kind: "artifact", name, mediaType, digest, size }` — the
  content address of the bytes, and nothing about where they live, so the store behind it can change
  without any message changing shape. This is the contract only: the transport that serves the bytes
  lands separately.

  The digest is the one field that is not taken on trust. `name`, `mediaType`, and `size` are
  whatever the sender wrote, and a receiver that sizes a buffer from `size` or dispatches on
  `mediaType` has believed a stranger; `verifyRawBytes` checks fetched bytes against the digest before
  they reach a caller, which is what catches a store handing back a truncated object — otherwise
  indistinguishable from a small one.

  `artifact` is a bare core kind rather than a namespaced extension, because reverse-DNS kinds are for
  wrapping vocabularies Cotal does not own, and this is Cotal's own reserved primitive. That
  distinction has teeth: a core kind the message validator does not know is not a schema detail. The
  validator gates the durable delivery frame, so an unrecognized core part means the backstop drops
  the whole message, silently, and the loss shows up nowhere near the part that caused it. The
  `artifact` guard is enforced there, and it checks the digest's form rather than only its type — a
  malformed digest is not a reference to anything, and admitting one would turn a bad message into a
  "missing artifact" that blames the store.

  Message rendering moves to a single `partsToText` in core. The same one-line expression had been
  copied into the connector inbox, `cotal join`, and the mesh view, and each copy fell back to
  stringifying a part's `data` field — which an artifact part does not have, so all three would have
  rendered it as the literal word "undefined". One renderer means a new core part kind is legible
  everywhere at once, or nowhere, never in two surfaces out of three.

- fd361fe: Serve the broker over TLS: the transport foundation, with the omission cases made unrepresentable.

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

  **Client-side strictness is NOT complete, and the honest scope is wider than a short list.** The
  broker refuses cleartext, so none of these connects in the clear against a healthy TLS broker — a
  NATS client upgrades the same socket once it reads `tls_required`. What they lack is their own
  requirement, which is the fence against a stripped or forged `INFO`, and that is the whole reason
  this feature exists.

  Two distinct cases, and the second is worse:

  _Never had a TLS path / passes `tls: false` explicitly._ `waitForDeliveryLease`
  (`packages/core/src/lease.ts`) builds its own `connect` options rather than going through
  `standaloneConnectOpts`. The user-auth service and the membership feed connect the same way.
  The **enumerated** `standaloneConnectOpts({ … tls: false })` sites at this tip (twelve, not a
  prose list) are:

  | File                                       | Lines              | Role                                                                                                                                                              |
  | ------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `packages/core/src/channels.ts`            | 166, 192, 217, 238 | channel-registry helpers                                                                                                                                          |
  | `packages/core/src/streams.ts`             | 322, 369, 398, 439 | stream/history helpers                                                                                                                                            |
  | `implementations/cli/src/commands/up.ts`   | 1155, 1234         | `provePreparedRestoreListener` / `proveOrdinaryResumeListener` authenticated JetStream proof (restore + ordinary-resume adopt only — not bare `up` / bare `down`) |
  | `implementations/cli/src/commands/down.ts` | 651, 691           | `assertControlPlaneQuiesced` / `readPresenceWithoutConsumer` — **only** on `down --preserve-state`, not bare `cotal down`                                         |

  Bare `cotal down` does **not** hit those two `down.ts` sites: it stops via pidfiles
  (`stopLocalProcess`) and never opens a broker wire. Live-checked twice: `up --detach --open
--tls-cert/--tls-key` then bare `down` (with `NODE_EXTRA_CA_CERTS` stripped on the down step) stops
  manager, delivery, and nats-server and leaves the port `ECONNREFUSED`. There is no silently-skipped
  safety gate on ordinary teardown.

  `down --preserve-state` is the only path that calls `assertControlPlaneQuiesced` (via
  `isReachable(mesh.server)` at `down.ts:585`, then the `tls: false` connects at :651/:691). Bare
  `isReachable(server)` is a plaintext INFO probe (`tcpInfoProbe`): on this branch's STARTTLS TLS it
  still returns **true** (INFO precedes the upgrade), so the quiescence gate is **entered**, not
  skipped, when the client trusts the CA. **Narrow residual (do not fix in this branch):**
  `down --preserve-state` **and** a CA the client does not trust — then a stricter `{tls:true}` probe
  would fail, the INFO probe still says up, and the subsequent authenticated connect without a trusted
  CA fails or the cut proceeds without a completed wire-truth lease proof depending on the failure
  mode. Same family as the private-CA diagnosis gap (S7); incomplete client fence, not an ordinary-path
  break. Flagless sites mostly **work** via auto-upgrade and are **unfenced** (no own requirement
  against a forged INFO), not "broken teardown."

  _Resolves the decision and then drops it (partially closed)._ `cotal web` now passes
  `tls: conn.tls` into its endpoint. `cotal status` carries `target.tlsRequired` on the Selected Mesh
  preflight, the open/auth live snapshot, the user-mode connection probe and user live snapshot, and
  the Recorded Meshes liveness check — a mesh recorded `tlsRequired: true` is not greened by a bare
  TCP/INFO probe against a plaintext substitute. What still drops the decision: the mesh manager
  (`startManagerDetached`'s options type has no `tls` field, so `ensureControlPlane` forwards `--tls`
  to the delivery daemon and then launches the manager without it), plus the never-had-a-path sites
  above.

  Client-side strictness landed for: `cotal up` (every route to a listener), the recorded mesh record
  (`MeshEntry.tlsRequired`), CLI-resolved connections that go through `resolveMeshTarget` /
  `endpointAuth`, `cotal status`, `cotal web`, and the delivery daemon's three dials. It has not
  landed for the manager process, the user-auth service, the membership feed, `waitForDeliveryLease`,
  or the twelve helper sites tabulated above. That table is the residual enumeration; do not collapse
  it back to prose.

  The delivery daemon is strict on all three of its dials, including the every-two-seconds reachability
  poll that re-presents its standing credential for the life of the process.

  **Also not included:** the `cotals://` handout from `up`; a rotation command; and `tls://` as a
  _server_ scheme enforcing anything (it is cosmetic at the client: nats.js connects plaintext to
  `tls://host` with empty options, and only the explicit `tls` option refuses). **Changing transport
  on a live broker is restart-only by construction:** passing `--tls-cert/--tls-key` (or dropping
  them) against an already-running mesh is refused — `cotal down`, then `cotal up` with the desired
  flags. A reload of `nats-server` is not offered, because it would leave established plaintext
  sessions alive.

  Operators using a private CA need `NODE_EXTRA_CA_CERTS`, because `EndpointOptions.tls` is a boolean
  and cannot carry a CA file. The private-key permission check is POSIX-only.

  **S10 (fixed in this change):** a `tlsRequired` registry entry used to be **pruned** when a
  `connectOrExit` / `preflightOrExit` path ran without a trusted CA. `preflightTarget` probes with
  `{tls:true}`; certificate verification failure was classified as `unreachable` (prune:true), so
  `cotal send dm …` (and any other preflighted command) deleted a healthy mesh record on a recoverable
  trust error — durable state destroyed because the operator forgot `NODE_EXTRA_CA_CERTS`. Fix: when
  the recorded target requires TLS and the TLS probe fails as unreachable, confirm plaintext INFO
  still advertises `tls_required: true` (with a second, longer read before condemning); if it does,
  classify as `tls-trust` with **prune:false**. That proves a TLS-required NATS listener is present —
  INFO is unauthenticated and is not mesh identity — so the record is conservatively kept and the
  operator is told to fix the trust store (`NODE_EXTRA_CA_CERTS`). A plaintext substitute on the same
  port does not advertise `tls_required` and still follows the normal unreachable/prune path.
  Live-checked both ways.

  **Named follow-ups (not fixed here):**

  - Defence-in-depth only: pass `mesh.tlsRequired ? {tls:true}:{}` at `down.ts:418`/`:585` and thread
    transport into `:651`/`:691` (measurement showed bare INFO already enters the preserve-state
    quiescence gate when the CA is trusted).
  - Bare `cotal down` pidfile-trust: hiding manager/delivery pidfiles while those processes still run
    lets bare down stop the broker and report success (pre-existing; filed separately).

- 185e721: Renew the `$SYS` credentials without tearing the space down.

  `membership-observer.creds` and `connection-evictor.creds` carry a 30-day expiry and are signed by
  the system-account seed, which is never persisted, so nothing re-signs them in place. The only
  repair the tooling named was "`cotal down` then a fresh `cotal up`", and that did nothing: `up`
  mints the pair only on the branch that _creates_ the trust record, so re-upping a provisioned space
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
  therefore broker-wide. `rotateSystemCreds` is exported from `@cotal-ai/workspace` and carries the
  multi-tenant guard itself rather than at the CLI flag. It is deliberately a workstation operation and
  takes no `SecretStore`: the `$SYS` pair has no store seam to be written through, and because a
  `SecretStore` cannot be enumerated, accepting one would mean a broker-wide guard that reads a local
  filesystem while enforcing nothing for the tenants actually at risk.

  A rotation requires every broker for the root to be stopped, and three checks now say so: this root's
  recorded mesh at the requested address, anything unidentified answering there (which refuses instead
  of relocating to a free port), and the root's own ownership records: a live or unreadable `nats.pid`,
  or any recorded mesh for this root still reachable. Without them a lost registry row, or a
  `nats-server` started by hand against this root's `server.conf`, was enough to bypass the running-mesh
  refusal: `up` found the port busy, picked a free one, rotated, and left the old broker serving the
  retired config while a second one ran against the same JetStream store. These are Cotal's ownership
  records rather than a scan of the process table, and the docs say so: a hand-started broker on a
  different port writes none of them and is the named residual.

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

  The recovery is covered end-to-end as well as in unit form: a suite drives the packaged binary
  against a real broker, a real delivery daemon and a real manager, on a root whose `$SYS` pair is
  already past its horizon. It asserts the reported symptom (the daemon's membership feed does not
  start, and says which credential and which repair), that `down` + a plain `up` leaves both files
  byte-identical and the doctor red, and that `down` + `up --rotate-sys` clears it in the daemon that
  reported it. The survival claim is checked rather than asserted: an agent credential minted before
  the rotation still connects afterwards, the CHAT stream returns at the same sequence and count, and
  registry state written before the rotation reads back through the CLI after it.

  Diagnosis now names the cause instead of the symptom. An expired observer cred used to surface as a
  bare "Authorization Violation" in the delivery log and, one layer up, as a `membership-rw` adoption
  refused with "membership feed is not running", neither of which mentions a credential. The daemon
  checks the observer's own expiry before connecting and reports it, carries that reason into the
  adoption reply, and the manager warns on every renewal pass from the 75% point onward rather than
  letting the mesh discover the expiry at the horizon. `cotal doctor auth`, `evictPrincipal`,
  `planeConnLiveness` and the two mint errors now print the repair that works. Where the feed is down
  because its bundle is incomplete rather than expired, the daemon now names the missing files and
  distinguishes the two cases: a missing `$SYS` observer is re-minted by a rotation, while a space
  predating broker-sourced membership is missing the rw cred and the account id as well, which a
  rotation does not write, so it is told the truth rather than sent through a stop/start that cannot
  help it.

### Patch Changes

- a306df0: Never consume a Claude Code peer's message without delivering it.

  An unattended agent could go permanently silent after a direct message. The connector's lifecycle
  hook acked the message and marked it handled while it was still only _formatting_ the hook reply
  that carries it, but that reply has to reach the runtime through the hook relay, which abandons the
  exchange after two seconds. When it did not land, the agent's model never saw the message while the
  connector had already committed it — and because the message was recorded as handled, its own
  JetStream redelivery was acked and discarded on arrival, so nothing could bring it back. The peer
  simply stopped answering, and only a human noticed.

  A message is now committed only once the reply carrying it has cleared both legs of its journey, not
  just the first. The hook relay confirms back to the connector only after its own write to the
  runtime has completed cleanly, and the connector waits for that receipt
  (`startControlServer` gains an additive `onReply(event, delivered)`, and a client opts in with
  `handoff: true`); anything less leaves the message un-acked, so it redelivers and the agent is woken
  again. Binding to the connector's own socket write was not enough: a large injection that the
  relay's one-second flush backstop kills mid-write reaches nothing, and the batch was still
  committed. The verdict is tracked per hook event rather than in one slot, because hook frames are
  separate connections that can overlap and would otherwise let one frame's outcome commit another
  frame's messages. This errs toward delivering twice rather than losing one: a re-surfaced batch is
  flagged as a possible repeat.

  Two further ways the same path could go quiet are closed. Presence updates no longer gate delivery —
  a failed presence write used to skip both the message injection and the end-of-turn flush of
  anything held while the agent was busy. And a rejected wake notification is now retried with a
  bounded backoff, since for an idle agent it is the only thing that can wake it.

- 141c4dd: Read channel history through the delivery daemon instead of a consumer you create yourself.

  Reading scrollback used to require the reader to hold consumer-create on the chat stream. That is a
  lot of authority for a read-only surface: it is the one grant shape the protocol's mediated-reads
  rule says an untrusted holder should not have, since it addresses the stream directly rather than the
  messages you are allowed to see. A read-only dashboard or UI paid for a page of history with it.

  `readHistory` moves that read behind the delivery daemon, which already holds the trusted reader and
  the membership authority. The caller asks for a channel and gets its recent messages back; the daemon
  is the one holding the consumer. The caller cannot claim to be someone else — the daemon takes the
  principal from the authenticated request itself and ignores any identity in the payload.

  The reason this is more than a reshuffle is when authorization is checked. A consumer decides what
  you may read at the moment it is created and then keeps serving you, so revoking someone's access
  mid-scroll does not stop the pages already flowing. The daemon re-reads the caller's permissions from
  the durable registry on every single call, so a revocation stops the very next read.

  A page is the newest N messages, with a flag saying whether older history remains behind it, because
  "there is more above this" and "this is the beginning of the conversation" are different answers and
  a UI that cannot tell them apart will render the first as the second. Asking for a channel you may
  not read fails loudly, and so does a read that could not complete; neither comes back as an empty
  page, which would look exactly like a channel nobody has posted to.

  This is additive. Nothing is removed and no existing caller changes: reading history the previous way
  still works, and moving to the mediated path is a separate migration. Chat channels only.

  Authorization is the live registry row intersected with the mint-time ceiling. Revoking access
  (narrowing the live row) stops the very next page. Widening the registry without re-minting the
  caller's credential does not grant history the broker would still deny — the ceiling only rises
  when the credential does.

- a74a768: Sandbox the temp root in the smokes that mint a mesh fixture there, so a `.cotal` left above the temp base (`/tmp/.cotal` on Linux CI runners) can no longer capture the fixture and make a suite grade a live mesh. One shared implementation in `bin/smoke/_scratch.ts`, used by `spawn-from-anywhere`, `down-target`, and both `ps` suites. The dead-manager cells now assert that the manager was found, was alive, and is dead, instead of skipping their own kill when the pid file is missing.
- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [a306df0]
- Updated dependencies [2768f5b]
- Updated dependencies [a26e5f2]
- Updated dependencies [019afc3]
- Updated dependencies [91b75e3]
- Updated dependencies [3539f20]
- Updated dependencies [463d597]
- Updated dependencies [9093440]
- Updated dependencies [d49f505]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [14ff831]
- Updated dependencies [11cd652]
- Updated dependencies [a74a768]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0
  - @cotal-ai/cli@0.17.0
  - @cotal-ai/connector-core@0.17.0
  - @cotal-ai/workspace@0.17.0
  - @cotal-ai/manager@0.17.0
  - @cotal-ai/auth@0.17.0
  - @cotal-ai/delivery@0.17.0

## 0.16.0

### Minor Changes

- 531d37d: Register, list and unregister meshes from the CLI.

  `cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open]` records a mesh this
  machine did not start — one running on another machine, a shared broker, a hosted space — so
  `--space`, `cotal use` and a bare `cotal spawn` can reach it from any directory. The broker is
  probed before anything is written, so a wrong address or credentials that mesh will not accept fail
  at registration instead of at the first spawn; `--force` records without verifying and replaces an existing
  record. `cotal meshes rm <space> …` drops records (never stopping a mesh: a mesh running here is
  refused in favour of `cotal down`) and releases the `current` pointer when it pointed at one.

  Registry records now carry an origin, and an automatic prune only ever deletes records that
  `cotal up` wrote. A record added by hand cannot be reconstructed by this machine, so an unreachable
  broker under one is reported — `offline` in `cotal meshes`, and a preflight failure that names
  `cotal meshes rm` rather than `cotal up` — instead of silently unregistering a mesh that was live
  all along.

- 498055c: Stop paying one network round trip per record, and return the recent messages history claimed to return.

  Several read paths issued one sequential round trip per record, which is invisible against a loopback
  broker and ruinous on any ordinary cross-continent link. Measured against a mesh at 534ms RTT with
  healthy uplinks at both ends, reading the membership feed took 30 to 34 seconds for 89 entries; it
  now takes under a second for 93.

  - `liveKvEntries` is the one sanctioned full-bucket KV read: a single pass whose request count is
    independent of record count, which collapses by greatest revision with tombstones so a deleted key
    cannot resurrect, and which binds its own consumer so that an empty result is PROVEN by the
    bind-time pending count rather than inferred from silence. A pass that is cut short raises rather
    than returning what arrived. That distinction is load-bearing on the ACL path: read this way, a
    dropped link mid-scan would otherwise report a provisioned principal as having no ACL row, and a
    durable join would be refused as "not provisioned" instead of as "could not read". The membership
    feed, the members and channel registries, and the ACL alias enumeration all read through it. No
    change to broker authority: the same ordered push consumer over the same subject.
  - `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
    requested limit, while being documented as recent and rendered everywhere as the latest. They now
    return the newest, read through a bounded window rather than by draining the backlog.
  - `cotal status` started the Claude CLI twice for data one listing contains.

  Two optimisations were attempted and REVERTED during review, and are not part of this change: the
  dashboard's activity feed still fetches a full page per channel (the cheaper version dropped
  genuinely-newer messages, because saturation counts messages rather than recency), and control
  commands still open a probe connection before the real one (skipping it flattened typed auth
  failures and lost the probe's deadline).

  This is the read-path half of the work. The registry-safety half — a failed network probe must not
  delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
  `cotal meshes add`.

### Patch Changes

- Updated dependencies [531d37d]
- Updated dependencies [498055c]
  - @cotal-ai/workspace@0.16.0
  - @cotal-ai/cli@0.16.0
  - @cotal-ai/core@0.16.0
  - @cotal-ai/auth@0.16.0
  - @cotal-ai/delivery@0.16.0
  - @cotal-ai/manager@0.16.0
  - @cotal-ai/connector-core@0.16.0

## 0.15.0

### Minor Changes

- f89560a: New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer, in Codex's own TUI. A host-mode peer drives a `codex app-server` thread over JSON-RPC: inbound batches wake a real turn, and directed messages steer INTO a live turn mid-flight.

  `cotal spawn --agent codex` opens Codex's own TUI. The app-server runs as a loopback websocket listener guarded by a per-incarnation capability token (0600, inside the agent's private home), and the TUI attaches to the very thread the mesh drives, so mesh turns render as they happen and anything you type is a real user turn on that same thread. With no terminal (piped output, CI, a smoke) the host stays headless with an activity feed instead; `COTAL_CODEX_TUI=1|0` picks the mode explicitly when the tty check would guess wrong. Once Codex owns the terminal the host's own log moves to `host.log` in the agent's private home, and the handoff line names that path so a later failure is findable.

  The shared `cotal_*` tools are served by the host process itself over a bearer-authenticated loopback MCP endpoint, with the token passed to codex by env var name so it never reaches the process table. Because the app-server is the MCP client, the same tools work on a mesh-driven turn and on one typed into the TUI; the connector's own tools are pre-approved so an unattended agent never stalls on an approval prompt nobody is watching, and `mcp_servers.cotal.*` is reserved and refused rather than silently overridden.

  Autonomy defaults suit an agent woken by peer messages when nobody is watching: `approval_policy=never` (never ask before running a command, not refuse), `sandbox_mode=workspace-write`, and `sandbox_workspace_write={network_access=true}`. Network is on because Codex's own workspace-write default has it off, which breaks installing a dependency or pushing a branch with an error that reads like the task is impossible rather than the sandbox refusing; filesystem containment is kept, because a peer's message is a remote input that can make the agent run commands. The network default is applied only where the sandbox is actually `workspace-write`, so tightening the mode does not leave a network grant in the launch. All three are overridable per spawn with `--opt` (including `sandbox_mode=danger-full-access` for no sandbox at all), while an interactive `approval_policy` is refused loud rather than auto-answered on the operator's behalf.

  The guide states the sandbox's guarantee literally: it blocks out-of-workspace local filesystem writes, and does not block reads, exfiltration, or networked side effects. With the network on, a peer-driven turn can read broadly and send what it reads, reach loopback and link-local services, and act through any credential it can read, including irreversibly, via a force-push or an API delete. Containing filesystem writes is not the same as containing damage, and the docs say so rather than implying the residual is disclosure-only. The offline, tighter-mode, and separate-OS-user mitigations are named in both the autonomy section and Limits.

  At-least-once delivery with exact-id acks on turn completion: a failed turn retries with backoff, an interrupt redelivers, and an app-server crash restarts the child in place on the same mesh lifecycle and re-drives the un-acked batch (a crash loop is fatal, never an endless respawn). Presence from the event stream, an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (a resumed codex thread comes up without its configured MCP servers, so the agent would be mute on the mesh) and tool-sharing.

  Also fixes the seed reconciler, which treated a generation match alone as up-to-date: a built-in connector added at an unchanged generation would never seed on an already-installed workstation (`--agent codex` reporting no connector installed). Both fast paths now also require every `SEED_BUILTINS` entry to be present in the ever-seeded set.

  A connector can now declare `launchHint`, the one line a foreground `cotal spawn` prints about what to expect next. That text used to be hard-coded to Claude Code's first-run gate for every agent type, telling operators of other harnesses to press Enter at a prompt that never appears.

  The web dashboard gains Codex branding (the OpenAI mark, from Simple Icons), so a codex agent renders with an icon and a label instead of a blank badge. That map was hand-maintained with nothing tying it to the connector set, so it is now covered by a test: every official connector must have a complete entry, and a new connector cannot ship icon-less with a green suite again.

### Patch Changes

- Updated dependencies [f89560a]
  - @cotal-ai/connector-core@0.15.0
  - @cotal-ai/core@0.15.0
  - @cotal-ai/workspace@0.15.0
  - @cotal-ai/cli@0.15.0
  - @cotal-ai/manager@0.15.0
  - @cotal-ai/auth@0.15.0
  - @cotal-ai/delivery@0.15.0

## 0.14.11

### Patch Changes

- Updated dependencies [ca962f7]
  - @cotal-ai/cli@0.14.11
  - @cotal-ai/core@0.14.11
  - @cotal-ai/workspace@0.14.11
  - @cotal-ai/manager@0.14.11
  - @cotal-ai/delivery@0.14.11
  - @cotal-ai/connector-core@0.14.11
  - @cotal-ai/auth@0.14.11

## 0.14.10

### Patch Changes

- dcde8df: Node-version preflight now gives the remedy that matches how cotal was installed. When the
  launcher written by `curl -fsSL https://get.cotal.ai | sh` is in use (it sets
  `COTAL_LAUNCHER=1`), a pinned runtime that has been replaced by an older Node points at
  re-running the installer, or at `--vendor-node` to stop depending on the system Node
  entirely, rather than at generic nvm advice. Installs that did not come from the installer
  keep the nvm guidance and now also mention the installer as an option.
  - @cotal-ai/core@0.14.10
  - @cotal-ai/workspace@0.14.10
  - @cotal-ai/cli@0.14.10
  - @cotal-ai/manager@0.14.10
  - @cotal-ai/delivery@0.14.10
  - @cotal-ai/connector-core@0.14.10
  - @cotal-ai/auth@0.14.10

## 0.14.9

### Patch Changes

- Updated dependencies [a4c082a]
- Updated dependencies [c88ef4c]
  - @cotal-ai/workspace@0.14.9
  - @cotal-ai/cli@0.14.9
  - @cotal-ai/manager@0.14.9
  - @cotal-ai/auth@0.14.9
  - @cotal-ai/delivery@0.14.9
  - @cotal-ai/core@0.14.9
  - @cotal-ai/connector-core@0.14.9

## 0.14.8

### Patch Changes

- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8
  - @cotal-ai/cli@0.14.8
  - @cotal-ai/manager@0.14.8
  - @cotal-ai/connector-core@0.14.8
  - @cotal-ai/auth@0.14.8
  - @cotal-ai/delivery@0.14.8
  - @cotal-ai/workspace@0.14.8

## 0.14.7

### Patch Changes

- Updated dependencies [12ad5e3]
  - @cotal-ai/manager@0.14.7
  - @cotal-ai/cli@0.14.7
  - @cotal-ai/workspace@0.14.7
  - @cotal-ai/auth@0.14.7
  - @cotal-ai/delivery@0.14.7
  - @cotal-ai/core@0.14.7
  - @cotal-ai/connector-core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/auth@0.14.6
  - @cotal-ai/cli@0.14.6
  - @cotal-ai/delivery@0.14.6
  - @cotal-ai/manager@0.14.6
  - @cotal-ai/core@0.14.6
  - @cotal-ai/connector-core@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [1a1c4e1]
  - @cotal-ai/manager@0.14.5
  - @cotal-ai/core@0.14.5
  - @cotal-ai/workspace@0.14.5
  - @cotal-ai/cli@0.14.5
  - @cotal-ai/delivery@0.14.5
  - @cotal-ai/connector-core@0.14.5
  - @cotal-ai/auth@0.14.5

## 0.14.4

### Patch Changes

- Updated dependencies [eccf48c]
  - @cotal-ai/manager@0.14.4
  - @cotal-ai/cli@0.14.4
  - @cotal-ai/core@0.14.4
  - @cotal-ai/workspace@0.14.4
  - @cotal-ai/delivery@0.14.4
  - @cotal-ai/connector-core@0.14.4
  - @cotal-ai/auth@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [fce3199]
  - @cotal-ai/connector-core@0.14.3
  - @cotal-ai/workspace@0.14.3
  - @cotal-ai/cli@0.14.3
  - @cotal-ai/manager@0.14.3
  - @cotal-ai/auth@0.14.3
  - @cotal-ai/delivery@0.14.3
  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- 5457b55: Require Node >= 22 and fail fast with a clear message on older Node.

  The bundled `nats-server` broker (`@eplightning/nats-server-*`) declares `engines.node >= 22`, and
  npm silently skips an optional dependency whose engine the running Node doesn't satisfy — so on any
  Node older than 22 the broker binary was never installed, surfacing later as a misleading
  "nats-server not found". Older Node also crashed the CLI outright on a Node-20+ regex in a transitive
  dependency, and only a non-fatal engine warning was emitted rather than a hard stop.

  The executable entry is now a thin Node-version preflight (`bin/cotal.ts`) that checks the running
  Node before any heavy import is parsed and hands off to the real composition root (`bin/run.ts`) only
  when it passes; on Node < 22 it prints an actionable message (upgrade Node; clear the npx cache if a
  stale install is being reused) and exits non-zero. The declared `engines.node` floor is corrected from
  `>=20` to `>=22` to match the broker's real requirement (Node 20/21 satisfied the old floor but
  never got the bundled broker), and the `nats-server` resolution error now names the root cause and
  the fix instead of a generic PATH hint.

- Updated dependencies [5457b55]
  - @cotal-ai/cli@0.14.2
  - @cotal-ai/core@0.14.2
  - @cotal-ai/workspace@0.14.2
  - @cotal-ai/manager@0.14.2
  - @cotal-ai/delivery@0.14.2
  - @cotal-ai/connector-core@0.14.2
  - @cotal-ai/auth@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies [cf6b82f]
  - @cotal-ai/cli@0.14.1
  - @cotal-ai/core@0.14.1
  - @cotal-ai/workspace@0.14.1
  - @cotal-ai/manager@0.14.1
  - @cotal-ai/delivery@0.14.1
  - @cotal-ai/connector-core@0.14.1
  - @cotal-ai/auth@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies [ffbb43f]
- Updated dependencies [8aee34e]
- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/cli@0.14.0
  - @cotal-ai/connector-core@0.14.0
  - @cotal-ai/core@0.14.0
  - @cotal-ai/workspace@0.14.0
  - @cotal-ai/manager@0.14.0
  - @cotal-ai/auth@0.14.0
  - @cotal-ai/delivery@0.14.0

## 0.13.2

### Patch Changes

- 6960658: The web dashboard now ships and versions with the `cotal-ai` binary. Previously `@cotal-ai/web` was fetched separately on its own version line, so upgrading the CLI (`npm i -g cotal-ai@new`) left the dashboard stale, and the documented `cotal ext add @cotal-ai/web` could not cross the 0.x caret to reach the new release, leaving customers on an old dashboard with no clean way forward.

  web is now a bundled first-party extension alongside the connectors: it is carried inside the `cotal-ai` package and the boot reconcile installs and version-refreshes it from that bundled payload at the binary's own version. So `npm i -g cotal-ai@X` brings the dashboard to X automatically and offline on the normal upgrade path, exactly like the connectors (a deliberate operator pin or a rollback is the operator's choice, same as any connector). To make this possible, web is repackaged to be self-contained — its marked/DOMPurify browser builds are copied into its own `dist` and served from there instead of resolving `node_modules` at runtime — so it seeds with no runtime dependencies.

  The bundle path is hardened so the update stays clean and verifiable: the prepack asserts every seeded payload's `name` and `version` match the umbrella (the `fixed` group keeps them lockstep), the reconcile verifies each (re)installed extension is recorded, on disk, and at the generation version before it stamps success (a version-skewed payload fails loud), and web publishes a `vendor-manifest.json` (name/version/license/sha512) of its bundled marked/DOMPurify so the shipped browser libs stay auditable.

- Updated dependencies [c3afdaa]
- Updated dependencies [9e3fdd6]
- Updated dependencies [666a1a1]
- Updated dependencies [2ed747d]
- Updated dependencies [9625ec6]
- Updated dependencies [6960658]
  - @cotal-ai/core@0.13.2
  - @cotal-ai/workspace@0.13.2
  - @cotal-ai/delivery@0.13.2
  - @cotal-ai/manager@0.13.2
  - @cotal-ai/cli@0.13.2
  - @cotal-ai/connector-core@0.13.2
  - @cotal-ai/auth@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [5fb7b23]
  - @cotal-ai/cli@0.13.1
  - @cotal-ai/connector-core@0.13.1
  - @cotal-ai/manager@0.13.1
  - @cotal-ai/core@0.13.1
  - @cotal-ai/workspace@0.13.1
  - @cotal-ai/delivery@0.13.1
  - @cotal-ai/auth@0.13.1

## 0.13.0

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

### Patch Changes

- Updated dependencies [5491661]
  - @cotal-ai/core@0.13.0
  - @cotal-ai/auth@0.13.0
  - @cotal-ai/manager@0.13.0
  - @cotal-ai/cli@0.13.0
  - @cotal-ai/delivery@0.13.0
  - @cotal-ai/connector-core@0.13.0
  - @cotal-ai/workspace@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [be66729]
- Updated dependencies [046f485]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/cli@0.12.0
  - @cotal-ai/core@0.12.0
  - @cotal-ai/workspace@0.12.0
  - @cotal-ai/manager@0.12.0
  - @cotal-ai/connector-core@0.12.0
  - @cotal-ai/auth@0.12.0
  - @cotal-ai/delivery@0.12.0

## 0.11.6

### Patch Changes

- 7b24953: Rebind extension peer links to the current Cotal host before lazy import, allowing global installs and source worktrees to share one extension prefix. Keep the Hermes launcher self-contained so it does not resolve a mutable host peer after launch.
- Updated dependencies [7b24953]
  - @cotal-ai/workspace@0.11.6
  - @cotal-ai/cli@0.11.6
  - @cotal-ai/auth@0.11.6
  - @cotal-ai/delivery@0.11.6
  - @cotal-ai/manager@0.11.6
  - @cotal-ai/core@0.11.6
  - @cotal-ai/connector-core@0.11.6

## 0.11.5

### Patch Changes

- 446ccc4: Resolve package-manager bin symlinks before locating the connector seed generation and bundled payloads.
- Updated dependencies [446ccc4]
  - @cotal-ai/cli@0.11.5
  - @cotal-ai/core@0.11.5
  - @cotal-ai/workspace@0.11.5
  - @cotal-ai/manager@0.11.5
  - @cotal-ai/delivery@0.11.5
  - @cotal-ai/connector-core@0.11.5
  - @cotal-ai/auth@0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4
  - @cotal-ai/workspace@0.11.4
  - @cotal-ai/cli@0.11.4
  - @cotal-ai/manager@0.11.4
  - @cotal-ai/connector-core@0.11.4
  - @cotal-ai/auth@0.11.4
  - @cotal-ai/delivery@0.11.4

## 0.11.3

### Patch Changes

- 1a954e8: Add the Pi host-native connector with confirmed custom-message delivery, cooperative shutdown, and a standalone extension artifact.
- Updated dependencies [1a954e8]
  - @cotal-ai/pi@0.11.3
  - @cotal-ai/core@0.11.3
  - @cotal-ai/workspace@0.11.3
  - @cotal-ai/cli@0.11.3
  - @cotal-ai/manager@0.11.3
  - @cotal-ai/delivery@0.11.3
  - @cotal-ai/connector-core@0.11.3
  - @cotal-ai/connector-claude-code@0.11.3
  - @cotal-ai/connector-hermes@0.11.3
  - @cotal-ai/connector-opencode@0.11.3
  - @cotal-ai/auth@0.11.3

## 0.11.2

### Patch Changes

- 93fd521: Add the installable Orca runtime, registry-driven extension providers and local-process lifecycle,
  selective shutdown, and `cotal endpoints` for the complete live presence roster.
  - @cotal-ai/core@0.11.2
  - @cotal-ai/workspace@0.11.2
  - @cotal-ai/cli@0.11.2
  - @cotal-ai/manager@0.11.2
  - @cotal-ai/delivery@0.11.2
  - @cotal-ai/connector-core@0.11.2
  - @cotal-ai/connector-claude-code@0.11.2
  - @cotal-ai/connector-hermes@0.11.2
  - @cotal-ai/connector-opencode@0.11.2
  - @cotal-ai/auth@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [5b2863a]
  - @cotal-ai/cli@0.11.1
  - @cotal-ai/workspace@0.11.1
  - @cotal-ai/connector-core@0.11.1
  - @cotal-ai/auth@0.11.1
  - @cotal-ai/delivery@0.11.1
  - @cotal-ai/manager@0.11.1
  - @cotal-ai/connector-claude-code@0.11.1
  - @cotal-ai/connector-hermes@0.11.1
  - @cotal-ai/connector-opencode@0.11.1
  - @cotal-ai/core@0.11.1
  - @cotal-ai/cmux@0.11.1
  - @cotal-ai/tmux@0.11.1

## 0.11.0

### Minor Changes

- 9061d0e: feat: per-user authentication (owner+actor identity, IdP login, credential death)

  Add per-user auth as a first-class mesh mode. A mesh brought up with `cotal up --user-auth --idp <url>`
  authenticates humans against an identity provider and issues short-lived, ledger-scoped bearers through an
  auth callout, in place of long-lived static credential files.

  - **owner+actor identity.** An instance's wire identity becomes the two-token principal `(owner, actor)`:
    every subject carries the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id`
    re-key onto the pair. Cross-owner and same-owner cross-actor forge/read isolation is enforced by the
    broker; the connection nkey survives only as the transport credential.
  - **Login and delegation.** Humans sign in with `cotal login --idp <url>` (device-code); operators grant
    access with `cotal actor grant`. Agents are spawned under the signed-in human as managed `(owner, actor)`
    children whose scope is a subset of the spawner's (the delegation envelope rule). Agent identities live in
    a separate managed-actor ledger space, exchanged via their own per-agent secret, so they outlive the
    human's login session.
  - **Credential death.** Every managed credential is now lifetime-bounded, with supervisor and delivery
    standing renewal, `$SYS` rotation-renewal, live connection eviction on revoke, and a `cotal doctor auth`
    repair surface. On a user-auth mesh, static agent creds are retired (the flip): revocation closes the live
    window at the next connect.
  - **Elevated operator surfaces.** `cotal web`, `console`, `history clear`, `channels set/default`, and
    `spawn -f` come online in user mode via server-authored elevated view bearers, minted only by the
    signed-in human exchange and gated on ledger scope (`admin` / `spawn`); `ps` and `status` are
    owner-domain scoped.
  - **Connectors.** Add the `cotal_docs` tool (version-exact Cotal docs the agent reads natively) and an
    opaque `launchOptions` raw passthrough for the Claude Code, OpenCode, and Hermes adapters.

### Patch Changes

- Updated dependencies [9061d0e]
  - @cotal-ai/core@0.11.0
  - @cotal-ai/workspace@0.11.0
  - @cotal-ai/cli@0.11.0
  - @cotal-ai/manager@0.11.0
  - @cotal-ai/delivery@0.11.0
  - @cotal-ai/auth@0.11.0
  - @cotal-ai/connector-core@0.11.0
  - @cotal-ai/connector-claude-code@0.11.0
  - @cotal-ai/connector-opencode@0.11.0
  - @cotal-ai/connector-hermes@0.11.0
  - @cotal-ai/cmux@0.11.0
  - @cotal-ai/tmux@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [e3a53e3]
  - @cotal-ai/core@0.10.1
  - @cotal-ai/workspace@0.10.1
  - @cotal-ai/cli@0.10.1
  - @cotal-ai/manager@0.10.1
  - @cotal-ai/connector-core@0.10.1
  - @cotal-ai/connector-claude-code@0.10.1
  - @cotal-ai/connector-opencode@0.10.1
  - @cotal-ai/connector-hermes@0.10.1
  - @cotal-ai/cmux@0.10.1
  - @cotal-ai/tmux@0.10.1
  - @cotal-ai/delivery@0.10.1

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.

### Patch Changes

- Updated dependencies [6c40280]
  - @cotal-ai/core@0.10.0
  - @cotal-ai/workspace@0.10.0
  - @cotal-ai/cli@0.10.0
  - @cotal-ai/manager@0.10.0
  - @cotal-ai/delivery@0.10.0
  - @cotal-ai/cmux@0.10.0
  - @cotal-ai/tmux@0.10.0
  - @cotal-ai/connector-core@0.10.0
  - @cotal-ai/connector-claude-code@0.10.0
  - @cotal-ai/connector-hermes@0.10.0
  - @cotal-ai/connector-opencode@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [14510c3]
  - @cotal-ai/core@0.9.1
  - @cotal-ai/manager@0.9.1
  - @cotal-ai/cmux@0.9.1
  - @cotal-ai/connector-claude-code@0.9.1
  - @cotal-ai/connector-hermes@0.9.1
  - @cotal-ai/connector-opencode@0.9.1
  - @cotal-ai/tmux@0.9.1
  - @cotal-ai/cli@0.9.1
  - @cotal-ai/delivery@0.9.1

## 0.9.0

### Minor Changes

- 1bcc154: feat: manager least-privilege — no allow-all credential — plus session resume

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — the message
  schema is unchanged and `protocolVersion` stays `0.2`; this release is about who the manager is
  allowed to be on the broker, plus a new way to bring an existing session into the mesh.

  **Security — the manager is no longer an all-powerful credential**

  Until now every manager action ran under a single, blanket `manager` credential that could do almost
  anything on the broker — read any DM, tamper with any stream, publish as any agent. That credential
  is **gone**. Manager work now runs under a set of small, purpose-built credentials, each able to do
  only its own job and nothing else:

  - The **always-on supervisor** can serve control requests, hold its lease, and publish presence — but
    it **cannot read anyone's messages, create arbitrary consumers, or delete/purge streams**.
  - **Spawning, teardown, and history-purge** each run on their own short-lived, tightly scoped
    credential that exists only for that operation.
  - The **CLI verbs** (`send`, `spawn`, `channels`, `up`, `join`, `down -f`, …) each connect as the
    least-privileged profile for the job — an operator posts only as itself and can never forge another
    agent.

  The practical effect: a leaked or compromised manager credential can no longer read message bodies or
  meddle with other agents' streams — the blast radius is contained to exactly what that one credential
  was scoped to. Control replies are bounded per caller, `cotal join` now self-provisions its own inbox
  (no more `ConsumerNotFound` on a fresh console), and `cotal down` tears down all of a space's streams
  and buckets rather than a subset.

  **New — resume an existing session into the mesh**

  `cotal spawn --resume <id>` and `cotal start --resume <id>` fork an existing `claude` session — its
  deep context and long transcript — into the mesh, instead of always starting an agent from scratch.
  It **forks, never hijacks**: the meshed agent gets a _new_ session branched off that transcript, and
  the original is left untouched. Connectors that can't support this (`opencode`, `hermes`) are
  **rejected up front, before any provisioning**, with a clear error rather than a half-provisioned
  space.

  **Fixes & UX**

  - **`cotal attach` shows the real screen on (re)attach to a full-screen agent.** Re-attaching, or
    attaching late, now reconstructs and repaints the agent's current screen instead of leaving you on
    a blank or partial one.
  - **Mouse-wheel scrolling works in full-screen agents over `cotal attach`.**
  - **The `pty` runtime fails loud under Bun.** It isn't supported there, so it now says so clearly
    instead of misbehaving silently.
  - **Removed the `face:` viewer that had leaked from the frontier-faces example into shared connector
    code**, so an OpenCode persona with a `face:` field boots normally. Face rendering lives entirely
    in `examples/04-frontier-faces`.

  **Migration — re-`up` spaces created before this release**

  The supervisor now records its lease in a per-space manager bucket that older spaces don't have. A
  space that was brought up on an earlier version must be re-`up`'d (a fresh `cotal up` is fine);
  otherwise the supervisor throws `stream not found` on its first lease write. Nothing on the message
  wire changed, so running agents and clients are otherwise unaffected.

### Patch Changes

- Updated dependencies [1bcc154]
  - @cotal-ai/core@0.9.0
  - @cotal-ai/cli@0.9.0
  - @cotal-ai/manager@0.9.0
  - @cotal-ai/delivery@0.9.0
  - @cotal-ai/cmux@0.9.0
  - @cotal-ai/tmux@0.9.0
  - @cotal-ai/connector-claude-code@0.9.0
  - @cotal-ai/connector-hermes@0.9.0
  - @cotal-ai/connector-opencode@0.9.0

## 0.8.3

### Patch Changes

- Updated dependencies [a10ed79]
  - @cotal-ai/connector-opencode@0.8.3
  - @cotal-ai/connector-claude-code@0.8.3
  - @cotal-ai/core@0.8.3
  - @cotal-ai/manager@0.8.3
  - @cotal-ai/connector-hermes@0.8.3
  - @cotal-ai/cmux@0.8.3
  - @cotal-ai/tmux@0.8.3
  - @cotal-ai/cli@0.8.3
  - @cotal-ai/delivery@0.8.3

## 0.8.2

### Patch Changes

- Updated dependencies [58b673a]
  - @cotal-ai/connector-opencode@0.8.2
  - @cotal-ai/core@0.8.2
  - @cotal-ai/cli@0.8.2
  - @cotal-ai/manager@0.8.2
  - @cotal-ai/delivery@0.8.2
  - @cotal-ai/cmux@0.8.2
  - @cotal-ai/tmux@0.8.2
  - @cotal-ai/connector-claude-code@0.8.2
  - @cotal-ai/connector-hermes@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [15fb826]
  - @cotal-ai/core@0.8.1
  - @cotal-ai/cmux@0.8.1
  - @cotal-ai/connector-claude-code@0.8.1
  - @cotal-ai/connector-hermes@0.8.1
  - @cotal-ai/connector-opencode@0.8.1
  - @cotal-ai/tmux@0.8.1
  - @cotal-ai/cli@0.8.1
  - @cotal-ai/delivery@0.8.1
  - @cotal-ai/manager@0.8.1

## 0.8.0

### Minor Changes

- cce0a6a: feat: mesh manifests, the tmux runtime, and a new `@cotal-ai/workspace` layer

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays `0.2`; this release is all tooling, packaging, and hardening. The new publishable
  `@cotal-ai/workspace` package joins the lockstep group.

  **New**

  - **Mesh manifests — describe and launch a whole topology from one `cotal.yaml` (`kind: Mesh`).**
    The file is organized by channel (each lists `subscribe`/`allowSubscribe`/`allowPublish` —
    Cotal's native verbs, holding agent names); a top `agents:` table resolves each name to a persona
    (bare path / file + overrides / fully inline) and a connector (`agent:`, per-agent or a top-level
    default — no silent default). Under `personaPermissions: include` a persona's own channel grants are
    inherited for channels the manifest doesn't declare.

    - `cotal up -f <cotal.yaml>` brings up a **fresh** mesh — broker + seeded channels + booted agents —
      and owns the whole space (`cotal down` tears it down). A broker already reachable at the
      manifest's address is refused with a redirect to `spawn -f`, never re-seeded as fresh.
    - `cotal spawn -f <cotal.yaml>` deploys a manifest **additively** onto a mesh that's already
      running: brand-new channels are seeded and owned, already-present ones are left untouched
      (`exists-unmanaged`), and exactly what it created is written to a creation-only ledger
      (`.cotal/manifests/<runId>.json`). A re-declared agent whose policy changed is **stale** and
      exits non-zero unless `--allow-stale <names>`; unmanaged actors with access to a declared channel
      are surfaced as a SECURITY warning.
    - `cotal down -f <cotal.yaml>` (or `--run <id>`) tears down **only** what a `spawn -f` run created —
      never foreign actors on the shared mesh. The ledger is treated as untrusted input and validated
      whole before any deletion; an owned agent is stopped only when its recorded name **and** id match
      the live one, cred paths are derived from the auth root and deleted without following symlinks,
      and an owned channel is removed only when no other members remain. Local-only: same checkout/host
      that created the run.
    - `cotal topology view -f <cotal.yaml>` validates a manifest and renders its access graph
      (per-channel and per-agent subscribe/read/post, persona-inherited scopes, warnings) — read-only,
      no broker needed. `--dry-run` previews `up -f`/`spawn -f` and mutates nothing.

    Resolved agents boot via a transient, non-authoritative launch artifact under `.cotal/run/` (no
    generated personas in `.cotal/agents/`), handed to the manager through a new **operator-only**
    `launch` control op that reads the run spec by id, never an arbitrary path.

  - **`@cotal-ai/tmux` — a tmux Runtime and `TerminalLayout` extension.** Each agent spawned via
    `--runtime tmux` gets its own window in a shared per-space tmux session, with P3 `env -i`
    isolation; a `TerminalLayout` provider lets `cotal setup` open and close tmux windows from the
    ambient `$TMUX` session. Self-registers on import (`import "@cotal-ai/tmux"`), exactly like
    `@cotal-ai/cmux`. `cotal setup` now offers a tmux demo when run inside a tmux session.

  - **Web graph — hide offline members by default**, with a toggle to show them. Backed by
    broker-sourced authoritative channel membership.

  **Architecture**

  - **New `@cotal-ai/workspace` package — the machine-local workstation layer, split out of
    `@cotal-ai/core`.** Core is now strictly the wire standard (endpoint, subjects, message types,
    extension contracts) and depends on nothing else in the repo; the `~/.cotal` mesh registry, target
    resolution, preflight, `.cotal/` auth-path I/O, and the `cotal …` command-copy renderer now live in
    `@cotal-ai/workspace`. Dependencies flow one way:
    `examples → implementations → workspace → core ← (peer) extensions`. A `smoke:core-boundary` guard
    (in `pnpm check` and CI) fails the build if core ever imports workspace.

    **Migration (importers only — no runtime/wire change):** `mesh-registry`, `mesh-target`,
    `preflight`, and the auth-path helpers (`authDir`/`findCotalRoot`/`loadSpaceAuth`/`saveSpaceAuth`)
    now import from `@cotal-ai/workspace` instead of `@cotal-ai/core`. Mesh-target failures throw a
    typed `MeshTargetError` (with a `code` and structured `details`); detect it with the exported
    `isWorkspaceTargetError(e)` guard rather than `instanceof`. The `cotal …`-flavored error copy is
    rendered through a single `renderWorkspaceError(...)` over a `target | preflight | reachable`
    union.

  - **`cotal ps` / `start` / `stop` / `attach` now resolve their broker from the mesh registry** — the
    same way `send` / `channels` / `console` / `web` and the manifest verbs already do — instead of
    silently defaulting to `nats://127.0.0.1:4222`. `--space <name>` finds the recorded broker (and
    mints the privileged `manager` cred from that mesh's own recorded root); `--server` stays an
    override and `--creds` a raw off-registry escape hatch. The shared mesh-target preflight is now
    used by both the transient commands and the manager control commands.

  **Fixes & hardening**

  - **Manager forwards the resolved channel ACL to spawned connectors**, so a manifest-spawned agent
    actually subscribes to the channels its persona grants (no missing `COTAL_SUBSCRIBE`).
  - **Never prune a recorded mesh on an explicit `--server` override** — an off-registry target no
    longer evicts the registry entry it didn't come from.
  - **Web graph correctness** — mode chips filter persistent edges (not just animation), hidden nodes
    stay hidden under the visibility filters, and dashboard assets are served with
    `cache-control: no-cache` so the UI doesn't get pinned to a stale build.
  - **`cotal attach` restores terminal modes on detach** — focus-reporting is reset and stdout writes
    are guarded against a dead pipe, so detaching no longer leaves the terminal in a wedged state.
  - **Security hardening** — symlink-safe run directories, launch-policy re-validation at spawn,
    tightened launch-spec validation, and the operator-only manager `launch` op (above).
  - **CI** — the security/protocol smoke suite (`smoke:ci`) and the mesh-resolution / spawn-from-anywhere
    / core-boundary smokes are gated in the `check` workflow.

  **Runtime defaults (carried from the tmux work)**

  The built-in `tmux` manager runtime is gone — `tmux` is resolved from `@cotal-ai/tmux`, exactly like
  `cmux`. The default `auto` mode is deterministic `pty`; tmux and cmux are never auto-selected. Choose
  them explicitly with `--runtime tmux`/`cmux`, which fails loud with a clear
  `"import @cotal-ai/<runtime>"` error if the matching extension isn't imported — no silent fallback to
  pty.

### Patch Changes

- Updated dependencies [cce0a6a]
  - @cotal-ai/core@0.8.0
  - @cotal-ai/cli@0.8.0
  - @cotal-ai/manager@0.8.0
  - @cotal-ai/delivery@0.8.0
  - @cotal-ai/cmux@0.8.0
  - @cotal-ai/tmux@0.8.0
  - @cotal-ai/connector-claude-code@0.8.0
  - @cotal-ai/connector-hermes@0.8.0
  - @cotal-ai/connector-opencode@0.8.0

## 0.7.0

### Minor Changes

- a6a0a8d: feat: agent orientation, spawn-from-anywhere, live space graph, model-aware spawning

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays 0.2.

  **New**

  - **`cotal_orientation`** — a self/context card MCP tool: an agent's identity, the channels it can
    read and post to, its capabilities, available tools, and who's present. Claude Code, OpenCode, and
    Hermes connectors all point new agents at it on boot for the same first-turn orientation.
  - **Spawn from any directory** — `cotal spawn` resolves a running mesh from a registry, so agents can
    be spawned outside the project directory. The registry self-prunes space-mismatched and stale
    `current` entries; its dir is locked to `0700` so space names aren't world-readable.
  - **Model- and harness-aware spawning** — `cotal start --model` overrides the model, the harness CLI
    is preflighted before spawn, and the harness/model knobs are shared across both spawn doors (CLI
    `cotal spawn` and MCP `cotal_spawn`).
  - **Live space graph** — a force-directed graph view of a space in the web UI, backed by
    broker-sourced authoritative channel membership (offline agents drop from the graph immediately).

  **Fixes & hardening**

  - **Manager persona spawn is fail-loud and ACL-correct.** A spawn (`start` op / `cotal_spawn` /
    roster boot) now treats its argument as a persona ref (a filename in `.cotal/agents`), takes the
    mesh identity from the file's `name:` (auto-numbered on collision), fails loud on a missing persona,
    and always provisions read/post ACLs from the loaded persona. Previously a miss silently minted
    default creds (read `general` only, default-deny publish, no capabilities), so a persona spawned by
    display name, a typo, or a renamed file became a live agent with silently-wrong ACLs.
  - **Mesh-connect resolution unified** — `web`/`console`/`join` (and the transient commands) route
    through a shared `resolveMeshTarget` + preflight: the recorded server/mode is honored (open ≠ auth),
    the `--server`+`--space` raw escape works again for open remote meshes, the `channels` subcommand is
    validated, and a silent wrong-mesh fallback is refused rather than connecting to the wrong broker.
  - **`cotal web` no longer holds the account signing seed.** The dashboard used to keep the space
    `SpaceAuth` (which can mint _any_ identity/role) in scope for the whole session, re-minting on every
    channel delete — a compromise of the loopback process could mint anything for the account. It now
    pre-mints one scoped `manager` cred at startup for the lone write path (channel delete) and lets the
    seed fall out of scope, shrinking the blast radius from "mint anything" to "purge channels as one
    manager". Open / `--creds` modes are unaffected (no seed; they use the connection creds).

### Patch Changes

- Updated dependencies [a6a0a8d]
  - @cotal-ai/core@0.7.0
  - @cotal-ai/cli@0.7.0
  - @cotal-ai/manager@0.7.0
  - @cotal-ai/delivery@0.7.0
  - @cotal-ai/cmux@0.7.0
  - @cotal-ai/connector-claude-code@0.7.0
  - @cotal-ai/connector-hermes@0.7.0
  - @cotal-ai/connector-opencode@0.7.0

## 0.6.0

### Minor Changes

- ba5e622: feat(delivery): server-side delivery daemon for the Plane-3 durable backstop, + auth-by-default

  Extracts the durable backstop (the offline catch-up tier) out of the manager into a standalone,
  least-privilege, server-side **delivery daemon** (`@cotal-ai/delivery`, the `deliver` command). The
  manager is now lifecycle-only (spawn/despawn/stop/attach/ps); the daemon owns all of Plane-3 — the
  fan-out writer + trusted reader, the durable-membership registry, the runtime durable join/leave/list
  ops (on a new `ctl.delivery` control service), activation catch-up, and a single-flight lease — and
  re-authorizes durable delivery against a durable read-ACL registry. Live channel reads are unchanged
  (native NATS, broker-enforced). No wire break (`protocolVersion` stays 0.2).

  - The daemon is part of the server: `cotal up` starts it by default and it is coupled to the broker
    (it exits if the broker is gone; `cotal down` / `cotal up` shutdown stop it).
  - **The mesh is now JWT-authed by default** — `cotal setup`/`go`/`up` bring up an authed mesh with the
    durable backstop; pass `--open` for the previous frictionless open, live-only mesh.
  - `cotal_channels` reports honest durable-delivery health (membership + lease aware).

  Hardened over multiple review rounds (sender-bound `ctl.delivery` replies, reconnect-safe responder +
  KV handles, ACL-independent leave so revocation closes the §7 boundary, signer-free daemon runtime,
  responder-after-bind readiness, pid-bound cutover marker), each with a guard smoke.

### Patch Changes

- Updated dependencies [ba5e622]
  - @cotal-ai/core@0.6.0
  - @cotal-ai/delivery@0.6.0
  - @cotal-ai/cli@0.6.0
  - @cotal-ai/manager@0.6.0
  - @cotal-ai/cmux@0.6.0
  - @cotal-ai/connector-claude-code@0.6.0
  - @cotal-ai/connector-hermes@0.6.0
  - @cotal-ai/connector-opencode@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [58f2d41]
  - @cotal-ai/core@0.5.0
  - @cotal-ai/cli@0.5.0
  - @cotal-ai/manager@0.5.0
  - @cotal-ai/cmux@0.5.0
  - @cotal-ai/connector-claude-code@0.5.0
  - @cotal-ai/connector-hermes@0.5.0
  - @cotal-ai/connector-opencode@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [878f406]
- Updated dependencies [878f406]
- Updated dependencies [878f406]
- Updated dependencies [878f406]
  - @cotal-ai/cli@0.4.0
  - @cotal-ai/core@0.4.0
  - @cotal-ai/manager@0.4.0
  - @cotal-ai/connector-opencode@0.4.0
  - @cotal-ai/connector-claude-code@0.4.0
  - @cotal-ai/connector-hermes@0.4.0
  - @cotal-ai/cmux@0.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [34c2cb7]
  - @cotal-ai/manager@0.3.2
  - @cotal-ai/core@0.3.2
  - @cotal-ai/cli@0.3.2
  - @cotal-ai/cmux@0.3.2
  - @cotal-ai/connector-claude-code@0.3.2
  - @cotal-ai/connector-hermes@0.3.2
  - @cotal-ai/connector-opencode@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [c74007a]
  - @cotal-ai/connector-hermes@0.3.1
  - @cotal-ai/core@0.3.1
  - @cotal-ai/cli@0.3.1
  - @cotal-ai/manager@0.3.1
  - @cotal-ai/cmux@0.3.1
  - @cotal-ai/connector-claude-code@0.3.1
  - @cotal-ai/connector-opencode@0.3.1

## 0.3.0

### Minor Changes

- df8e64c: Add `cotal-ai` — a guided, two-tier setup. The composition root (`bin/`) ships as the
  publishable `cotal-ai` package, so `npm i -g cotal-ai` / `npx cotal-ai <cmd>` works (bare
  `cotal` runs `setup`). The **first run** is a narrated, branded flow (`@clack/prompts` UI,
  wordmark splash, a live pane that streams the mesh booting) that checks prerequisites, locates
  the NATS server (bundled platform binary via `@eplightning/nats-server-*`, or one already on
  PATH), then a **connector picker** (Claude / OpenCode — only Claude installs a plugin; OpenCode
  auto-wires at spawn), and writes two default Cotal experts you can chat with — **david — the
  engineer** (how it works) and **sven — the guide** (what to build) — plus **me**, the session
  you drive. The finale is cmux-aware: inside cmux it opens a manager tab that pre-spawns david/sven
  into their own tabs alongside a console + driving session, otherwise a background manager
  pre-spawns them and the terminal is handed to your session. **Later runs** are a compact
  ensure+status card; `cotal setup --full` forces the full flow, and `cotal setup --yes` runs it
  non-interactively (agents/CI) — installs the plugin, writes the experts, starts the web, and exits
  non-zero with the log path on failure. Each failed interactive step offers a Claude handoff
  (skippable with `COTAL_SKIP_ASSIST=1`) that carries the failure context and resumes setup on
  `/exit`.

  Supporting changes across the stack:

  - **core** — `Connector.pluginRoot` (find a connector's installable plugin assets without
    importing the extension), `LaunchOpts.prompt` (an auto-submitted first message), a `TerminalLayout`
    extension contract (a host-side, not-wire contract: open/close editor tabs from a backend-agnostic
    `Tab` — panes as argv + an optional split — resolved by name from the registry), and `findCotalRoot`
    (walk up to `.cotal/`, so `cotal` runs from any subdirectory).
  - **connector-core** — `cotal_purge`, an agent-driven request that has the manager clear the
    space's retained chat backlog (the privileged `STREAM.PURGE` regular agents are denied).
  - **manager** — pre-spawn teammates at startup (`cotal cmux --spawn a,b`, staggered on presence),
    the `purge` control op (native JetStream purge), and a WS attach endpoint.
  - **cmux** — a self-registering `TerminalLayout` provider (plus `listWorkspaces`/`workspaceRefs` on
    the driver) that translates the agnostic `Tab` into cmux's native layout, so `cotal setup`
    opens/closes cmux tabs through the registry without depending on the package or building any
    cmux-shaped layout itself.
  - **connector-claude-code** — MCP isolation for spawned sessions (`--strict-mcp-config` +
    `--mcp-config`, channel ref `server:cotal`), `prompt` passthrough, and the plugin manifest files
    shipped in the published package.

  Adds `cotal up --detach` + `cotal down` for a background mesh. `cotal up` now pre-creates the
  space's JetStream streams + KV buckets for **both** modes (open connects without creds), so
  anything that touches a stream before an endpoint has joined — `cotal spawn`'s DM-inbox
  provisioning, `cotal_purge`, `history clear` — works on a fresh open mesh instead of failing with
  StreamNotFound. When run via `npx` without a global
  `cotal`, setup offers to `npm i -g cotal-ai` (default yes; non-interactive takes the default),
  best-effort — and the status-card hints render the right prefix (`cotal` / `npx cotal-ai` /
  `pnpm cotal`) for how you ran it.

### Patch Changes

- Updated dependencies [df8e64c]
  - @cotal-ai/cli@0.3.0
  - @cotal-ai/manager@0.3.0
  - @cotal-ai/core@0.3.0
  - @cotal-ai/cmux@0.3.0
  - @cotal-ai/connector-claude-code@0.3.0
  - @cotal-ai/connector-hermes@0.3.0
  - @cotal-ai/connector-opencode@0.3.0
