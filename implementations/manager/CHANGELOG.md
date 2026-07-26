# @cotal-ai/manager

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- 1a1c4e1: Bind an attach capability to the agent incarnation, not the reusable name.

  0.14.4 made attach capabilities single-use, short-lived tickets bound to the one agent name the
  manager had just authorized. A name, however, is a reusable slot rather than an identity: if the
  authorized agent exits and a same-name successor takes that slot within the ticket's two-minute
  lifetime, the untouched URL would attach the successor's terminal. On a per-user-auth mesh that
  successor can belong to a different owner, which turns it into a cross-owner terminal handover, the
  same class of boundary failure the ticket was introduced to close.

  A ticket is now bound to the agent _handle_ it was issued against. The manager creates a new handle
  per spawn, so a successor can never compare equal to its predecessor, and redemption re-resolves the
  name and requires the same incarnation. Issuing a capability for an agent that is not running is now
  a loud error rather than a ticket that quietly never redeems.

  Covered by two added checks in `smoke:attach-auth` (40 total): a ticket is refused once a same-name
  successor occupies the slot, and `url()` refuses to issue for an unknown agent.

  - @cotal-ai/core@0.14.5
  - @cotal-ai/workspace@0.14.5

## 0.14.4

### Patch Changes

- eccf48c: Make `cotal attach` reach a manager on another machine, and credential that endpoint properly.

  The manager's attach face bound a hardcoded `127.0.0.1` and advertised that same literal in the URL
  it handed back over the control plane, so a remote operator dialed their own loopback and got
  `ECONNREFUSED`. Attach only ever worked when the manager happened to be on the same box.

  **Where it binds is now an explicit decision.** The endpoint takes a bind address, still loopback by
  default, so a bare `cotal supervise` and an embedded `Manager` keep exactly the machine-local
  endpoint they have always had. `cotal up` passes the address it bound the broker to (via a new
  `supervise --console-host`), which is what makes a remote attach work. The broker's _dial_ address is
  deliberately not reused as the _bind_ address: a manager may supervise a broker on another host and
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

  - @cotal-ai/core@0.14.4
  - @cotal-ai/workspace@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [fce3199]
  - @cotal-ai/workspace@0.14.3
  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- @cotal-ai/core@0.14.2
- @cotal-ai/workspace@0.14.2

## 0.14.1

### Patch Changes

- @cotal-ai/core@0.14.1
- @cotal-ai/workspace@0.14.1

## 0.14.0

### Minor Changes

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

### Patch Changes

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/core@0.14.0
  - @cotal-ai/workspace@0.14.0

## 0.13.2

### Patch Changes

- c3afdaa: fix(renewal): prove the broker accepted a re-signed daemon credential before reporting it adopted

  `cotal doctor auth` could report a renewal "adopted" that the broker never accepted (a false green). The daemon's credential-reload path now proves acceptance on a disposable preflight connection before it adopts, and the record + `doctor` verdict only ever claim what was proven:

  - The delivery-admin `reloadCreds` reply narrows to `brokerAccepted` (identity/iat/exp actually accepted) plus a best-effort `residentSwap`, never an unwitnessed "adopted".
  - The passive 75% renewal timer and the explicit reload share one single-flight transaction and both preflight before installing a candidate, so a rejected credential in the store can never strand the live connection.
  - The whole daemon-side transaction is deadline-bounded (under the manager's request bound) with a late-commit fence, so a hung store fails loud instead of a silent "no responder".
  - `cotal doctor auth` now exits non-zero and says so when the last renewal was refused by the broker, instead of letting cred-file health alone stand as healthy.
  - The ephemeral generation fingerprint used to bind the expected generation is redacted at the persistence boundary, so it never lands in `.cotal/renewal.json` or logs.

- 2ed747d: feat(secret-store): migrate the membership feed's rw credential onto the store seam with proven standing renewal

  The broker-sourced graph feed's data-account (rw) credential now moves as a full read/write/delete kind through the `SecretStore` seam, so a hosted composition can renew it end-to-end (KMS/Vault) the way `delivery.creds` already does. Local `cotal up` is byte-for-byte unchanged (the default is the workstation FS store).

  - The feed's rw connection adopts credentials the way the endpoint does: an async source read outside the (synchronous) authenticator, a preflight-proven cache, a 75%-of-lifetime renewal timer, and a single-flight transaction bounded by an absolute deadline. Its authenticator now only ever presents the last **broker-proven** credential, so an incidental reconnect can no longer present an unproven or broker-refused generation and strand the feed.
  - The renewal owner (the manager) and the daemon now share one `SecretStore`: `Manager` takes an optional `secretStore` (defaulting to the workstation FS store) that feeds `remintDaemonCreds` and every per-agent secret kind, and `startMembership` reads the rw credential through the injected store. A hosted composition that hands the manager and the delivery daemon the same store renews both daemon kinds without a restart.
  - `cotal up` writes, and `cotal clean all` deletes, `membership-rw.creds` through the seam (never a raw filesystem write/remove), matching the `delivery.creds` discipline.
  - `credsRenewalDelayMs` (the 75% renew-early convention) is shared from `identity` so the endpoint and the feed compute it identically.

- Updated dependencies [c3afdaa]
- Updated dependencies [2ed747d]
- Updated dependencies [9625ec6]
- Updated dependencies [6960658]
  - @cotal-ai/core@0.13.2
  - @cotal-ai/workspace@0.13.2

## 0.13.1

### Patch Changes

- @cotal-ai/core@0.13.1
- @cotal-ai/workspace@0.13.1

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
  - @cotal-ai/workspace@0.13.0

## 0.12.0

### Patch Changes

- be66729: Add offline full-space and registry-only backup, preservation cuts, authenticated operation-isolated
  restore, conservative checkpoint recreation, same-principal resume, and explicit fallback cleanup.
  Remove the incomplete channel export surface.
- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.
- Updated dependencies [be66729]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/core@0.12.0
  - @cotal-ai/workspace@0.12.0

## 0.11.6

### Patch Changes

- Updated dependencies [7b24953]
  - @cotal-ai/workspace@0.11.6
  - @cotal-ai/core@0.11.6

## 0.11.5

### Patch Changes

- @cotal-ai/core@0.11.5
- @cotal-ai/workspace@0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4
  - @cotal-ai/workspace@0.11.4

## 0.11.3

### Patch Changes

- @cotal-ai/core@0.11.3
- @cotal-ai/workspace@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/core@0.11.2
- @cotal-ai/workspace@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [5b2863a]
  - @cotal-ai/workspace@0.11.1
  - @cotal-ai/core@0.11.1

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

## 0.10.1

### Patch Changes

- e3a53e3: Add a connector-agnostic model/variant selector: the `cotal models` command, a `--variant` flag on spawn, and the core `listModels` / `ModelCatalog` + `LaunchOpts.variant` contract. OpenCode discovers its models and variants from the installed CLI; Claude and Hermes reject variants (fail loud) and set `COTAL_MODEL` when a model is given.
- Updated dependencies [e3a53e3]
  - @cotal-ai/core@0.10.1
  - @cotal-ai/workspace@0.10.1

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

## 0.9.1

### Patch Changes

- 14510c3: Manager detached-launch hardening (#159 Part B). A detached launch now reports
  `started` only when the agent actually joins the mesh (presence-based readiness);
  a dead-on-arrival launch surfaces as a failure with its tail output instead of a
  false success, and a launch that neither joins nor exits within the backstop is
  reported as uncertain rather than assumed up. On exit — despawn, crash, shutdown,
  or lease loss — the manager deprovisions the agent's minted broker footprint (its
  `dm_`/`dlv_` durables and ACL row) through a new target-pinned, least-privilege
  `deprovisioner` profile, so exited agents no longer leave durable litter behind.
- Updated dependencies [14510c3]
  - @cotal-ai/core@0.9.1
  - @cotal-ai/workspace@0.9.1

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
  - @cotal-ai/workspace@0.9.0

## 0.8.3

### Patch Changes

- a10ed79: OpenCode connector: mirror each agent's session transcript to its per-agent `tr-<name>` channel, event-driven from the plugin's in-process bus events (`message.updated` / `message.part.updated` / `session.idle`) — parity with the Claude connector, with no per-turn session refetch. The `tr-<name>` channel convention is exposed through the `Connector` contract (`Connector.transcriptChannel`) so the manager can grant the agent's publish ACL without the channel literal living in `@cotal-ai/core`, and the manager forwards control-plane `capabilities` (`COTAL_CAPABILITIES`) so a manifest-spawned agent exposes the `cotal_spawn` / `cotal_persona` tools its creds already authorize. Adds an end-to-end smoke for the mirror (`smoke:opencode-transcript`).
- Updated dependencies [a10ed79]
  - @cotal-ai/core@0.8.3
  - @cotal-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- @cotal-ai/core@0.8.2
- @cotal-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [15fb826]
  - @cotal-ai/core@0.8.1
  - @cotal-ai/workspace@0.8.1

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
  - @cotal-ai/workspace@0.8.0

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

## 0.5.0

### Minor Changes

- 58f2d41: Self-serve channel join + durable backstop (SPEC v0.3 delivery rebuild)

  Agents whose read ACL allows a channel now join/leave its **live** feed themselves over a native NATS core subscription — manager-free, broker-enforced by `sub.allow` (join = subscribe, leave = unsubscribe). A manager-hosted **Plane-3 durable backstop** (a privileged fan-out writer → a trusted reader that re-authorizes every entry against the current read ACL and membership interval → a per-member DELIVER durable the agent acks natively, SPEC §8) ensures a post still reaches a busy or offline agent on its next turn. Channel membership moves to a privileged cursored KV registry (`cotal_members_<space>`), and channels carry explicit `live`/`durable` delivery classes (default `durable`; a space with no manager is live-only).

  The legacy per-instance `chat_<id>` live-tail durable and the mediated filter-move are removed — one clean model with no coexistence code. This is a wire-protocol change (SPEC bumped to v0.3): new and old clients do not interoperate on channel delivery.

### Patch Changes

- Updated dependencies [58f2d41]
  - @cotal-ai/core@0.5.0

## 0.4.0

### Minor Changes

- 878f406: Control-plane security hardening, agent env isolation, and spawn ergonomics

  - **Three-tier control authz.** Control ops are split into self-service / privileged / admin
    tiers, default-deny, with op↔tier routing that fails closed. `spawn` is now a declared
    capability (`AgentDef.capabilities` → mint → credential grant); destructive / cross-agent ops
    (including `purge`) require the admin tier and are denied to ordinary spawn-capable agents.
  - **Loopback by default.** The control plane binds `127.0.0.1` by default; `--open` is an
    explicit, auth-independent choice and no longer binds `0.0.0.0`.
  - **Spawned-agent environment isolation.** Runtimes pass only the declared env allow-list, never
    `process.env`, with per-connector model-key forwarding — no secret bleed between agents
    (verified by the new `env-isolate` smoke).
  - **Fork-bomb / churn bounding.** A synchronous `MAX_AGENTS` reserved-set ceiling, a
    minimum-lifetime cooling floor, and recursive child reaping bound runaway spawning.
  - **`attach` scoping.** Terminal read/write is gated to an operator's own children, or to the
    admin tier. The `control-auth` smoke asserts the credential boundary is enforced by
    nats-server.
  - Agent transcript mirroring is now opt-in (default off); `spawn` names auto-number on collision.

### Patch Changes

- Updated dependencies [878f406]
  - @cotal-ai/core@0.4.0

## 0.3.2

### Patch Changes

- 34c2cb7: fix(manager): clear all Claude startup gates in the pty runtime

  Claude ≥2.1.178 shows two back-to-back Enter-to-confirm gates on a fresh workspace (folder trust, then the dev-channels warning); the one-shot auto-confirm cleared only the first and hung managed agents at `starting…`. The pty runtime now presses Enter on a short timer during startup (matching the cmux runtime) instead of matching prompt text, so it clears the variable number of gates and the agent joins the mesh.

  - @cotal-ai/core@0.3.2

## 0.3.1

### Patch Changes

- @cotal-ai/core@0.3.1

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
  - @cotal-ai/core@0.3.0

## 0.2.0

### Minor Changes

- 739649a: Spaces model, operator console, cmux onboarding, personas, and faces (PRs #15–#20).

  - **cli** — a lazygit-style Ink `console` over a shared `MeshView`, plus `setup`/`supervise`/`cmux`/`demo` onboarding.
  - **manager** — registry-resolved runtimes (the manager no longer depends on cmux), graceful stop, and `definePersona`.
  - **cmux** — a self-registering `cmux` `RuntimeProvider` with real teardown.
  - **connector-core** — `cotal_persona` and `cotal_despawn` tools.
  - **connector-opencode** — an optional animated face viewer (avatar id read from the agent file's `meta.face`).
  - **core** — space discovery (`listSpaces`/`deleteSpace`), a pluggable `Runtime` extension contract, `DEFAULT_SPACE`, `saveAgentFile`, and a generic `meta` passthrough bag (kept a patch to avoid force-majoring the connectors that peer-depend on core).

### Patch Changes

- Updated dependencies [b3a790e]
- Updated dependencies [739649a]
  - @cotal-ai/core@0.1.3

## 0.1.2

### Patch Changes

- 5f9e171: Publish all packages: add repository field for OIDC provenance, plus in-flight changes (cmux runtime exec-via-env fix, manager runtime selector, .gitignore product/, etc.).
- Updated dependencies [5f9e171]
  - @cotal-ai/core@0.1.2
  - @cotal-ai/cmux@0.1.2

## 0.1.1

### Patch Changes

- 18c271f: Publish all packages: configure GitHub Actions changesets workflow with npm OIDC trusted publishing.
- Updated dependencies [18c271f]
  - @cotal-ai/core@0.1.1
  - @cotal-ai/cmux@0.1.1
