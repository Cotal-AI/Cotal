# @cotal-ai/auth

## 0.27.0

### Patch Changes

- Updated dependencies [900f630]
  - @cotal-ai/workspace@0.27.0
  - @cotal-ai/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [aa1fe5f]
  - @cotal-ai/workspace@0.26.0
  - @cotal-ai/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/workspace@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [b7cc4fa]
  - @cotal-ai/core@0.24.0
  - @cotal-ai/workspace@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [5634356]
  - @cotal-ai/workspace@0.23.0
  - @cotal-ai/core@0.23.0

## 0.22.0

### Patch Changes

- dfad94f: Fix two refusals that told an operator to run a grant which silently widened the row

  `cotal actor grant` is an upsert of the WHOLE row. Every flag the operator does not name is filled
  from the wide default: `>` read, `>` post, `spawn,role:default` scope. Two refusals printed a
  re-grant that named `--scope` and nothing else, so following either one reset the row's channel ACLs
  to everything.

  The elevated-view refusal is the sharper of the two. Asked for a view the grant lacks, it printed
  `cotal actor grant <actor> --owner <owner> --scope <current+needed>` and called that "the upsert
  replaces the scope list". An operator adding one view to a deliberately narrow row reset that row's
  read and post sets to `>` and `>` in the same paste, and the same sentence sent them to
  `cotal actor list` to confirm, where the widened row reads as confirmation that it worked. The row
  is a human operator's, and the ACL is minted fresh at every connect, so it takes effect on the next
  one with no restart.

  The missing-spawner refusal has the longer reach. Repairing a broken delegation chain, it printed
  `cotal actor grant <actor> --owner <owner> --scope spawn` and stopped, authoring a spawner that
  reads and posts on every channel. A spawner's own ACL is the ceiling every agent beneath it is
  attenuated against, so one pasted repair set a whole-plane ceiling for everything spawned under it
  from then on.

  The two doors now differ, on purpose. The elevated-view refusal has the row in hand, so it prints
  every field it is replacing, values included. The two delegation refusals have no row to copy from,
  so they print NO runnable command at all and name the flags and the wide default in prose instead:
  a line carrying channel values would invent them, and a line short of all three flags widens on
  paste. Both say what leaving a flag off means. `docs/cli.md` no
  longer tells a reader that a re-grant adds to the current scope, the `cotal actor grant` usage line
  now states what an omitted flag defaults to, and the two remaining hints that name a bare grant say
  that it is the full envelope, matching the wording `cotal login` already used.

  Both refusals are gated by cells that parse the service's own refusal string rather than matching a
  hardcoded command, so the text and the assertion cannot drift apart, and a mutation per site reverts
  each refusal to its shipped text and reddens that cell.

  The strings are not new. Every release from v0.11.0 to v0.21.0 carries all three, which is the whole
  life of the per-user actor ledger. Nothing about the on-disk row changes here, so no migration is
  needed, but an operator who followed either refusal should check the affected rows with
  `cotal actor list`: a widened row cannot be told from a deliberately full one, since the row records
  only when it was granted, not what it held before.

- Updated dependencies [57d3a57]
  - @cotal-ai/workspace@0.22.0
  - @cotal-ai/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [4cf5f72]
- Updated dependencies [219d33c]
- Updated dependencies [9c2412c]
  - @cotal-ai/core@0.21.0
  - @cotal-ai/workspace@0.21.0

## 0.20.1

### Patch Changes

- Updated dependencies [2752fe7]
  - @cotal-ai/core@0.20.1
  - @cotal-ai/workspace@0.20.1

## 0.20.0

### Patch Changes

- @cotal-ai/core@0.20.0
- @cotal-ai/workspace@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [48c6631]
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
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [8572a5d]
  - @cotal-ai/core@0.19.0
  - @cotal-ai/workspace@0.19.0

## 0.18.0

### Minor Changes

- 0ab9b4d: Move the auth plane's retirement rail off the retired `ctl` surface onto the endpoint subjects

  The auth plane served its generic "retire a lifecycle" operation on
  `ctl.auth-admin.<owner>.<actor>`, a rail the spec retires in full and states must
  not be handled. Rows written onto a deleted rail are defects rather than
  exceptions to it, so the rail moves to
  `ep.one.auth.retire-lifecycle.handle.<target triple>.<caller triple>.<nonce>`
  instead of the cut growing a carve-out.

  Two things get stronger on the way. The reply is now derived from the parsed
  request, so there is no argument through which a caller- or payload-supplied
  reply target could arrive; and the request and reply planes are disjoint, so the
  listener credential cannot express a request subject at all. The per-despawn
  requester credential now pins both its caller triple and exactly one target
  incarnation, so a leaked requester cannot be re-aimed at another lifecycle.

  Serve-time authorization additionally requires that the serve registration a
  request names belongs to the requesting principal. The previous two-token
  subject could not express the caller beyond a recyclable alias, so the rail
  accepted any registered instance's registration. This is alias-level binding:
  the registration is keyed by an id that is stable across restarts and carries no
  lifecycle uid, so a same-principal predecessor presenting the current epoch is
  still accepted.

  The spec rows also described an authorization mechanism the implementation had
  already replaced, and now describe what ships.

  This is a subject-plane migration, not a completed endpoint migration. The rail
  carries the endpoint subjects but still exchanges the pre-v0.4 request and reply
  bodies, registers no service record, serves no `describe`, and has no contract
  artifact — so a generic endpoint client can neither discover nor invoke the
  command. That gap is tracked separately, with the acceptance test being that a
  generic client can do both. The one acceptance-path hole is closed here rather
  than deferred: the request carries an id, the reply echoes it, and a reply that
  does not echo is refused, so a wrong-id success cannot clear a retirement hold.

  The requester's grant pins its target with the `handle` mode, which is normatively
  redemption-minted. This path is not: there is no issuer-signed artifact, no
  redemption step, and no lineage — the row is built directly from the minting
  manager's coordinates under root authority. It is used because it is the only
  target mode that can pin an exact incarnation, and the serve-time handler
  re-checks that triple against the current mapping. This is a documented
  deviation, not compliant handle semantics, and it is stated at the mint site and
  in the ownership matrix row. It resolves with the same tracked work as the
  envelope, since the mode and the envelope are one wire-conformance surface.

### Patch Changes

- Updated dependencies [0ab9b4d]
- Updated dependencies [208ad1f]
- Updated dependencies [665b378]
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0
  - @cotal-ai/workspace@0.18.0

## 0.17.0

### Patch Changes

- 14ff831: Stop reading another user's live process as dead.

  Asking the kernel about a process has three answers, not two: it is there, it is gone, or it is
  there but not ours to signal (`EPERM`). A two-state probe folds the third into "gone", and the
  caller then acts on a running process as if it had died.

  The repo already had a tri-state contract that gets this right, documenting itself as "consumed
  everywhere". Two production files imported it. Sixteen other production call sites probed inline,
  and **seven of the fourteen files handled `EPERM` correctly on their own while seven did not**, so
  this was a coin flip repeated fourteen times rather than one broken helper.

  Fixed, with the wrong answer named at each site:

  | site                       | what the old probe did                                                                        |
  | -------------------------- | --------------------------------------------------------------------------------------------- |
  | `manager-proc.managerUp`   | reported no manager, so `ensureManager` starts a second one onto a live one                   |
  | `delivery-proc.deliveryUp` | same, for the delivery daemon: two daemons on one fanout                                      |
  | `auth` `agent-bearer`      | "the user-auth service is not running, restart it with `cotal up`" about a service that is up |
  | `auth` provider            | same misread on the readiness path                                                            |
  | `cli ext`                  | printed "stale pidfile" about a live extension, which is advice to delete it                  |

  Both `up` functions also parsed their pidfile with `Number.isFinite`, which admits fractional and
  out-of-range values `process.kill` throws on. They now use the contract's bounded parser.

  The contract moved from `implementations/cli/src/lib/pid.ts` to `@cotal-ai/workspace`, the widest
  tier that may hold a local-process concept. **"Consumed everywhere" was never reachable and the
  claim hid the gap:** `extensions/*` peer-depend `core` only, and a pid probe is not a wire concept,
  so reaching them would mean leaking a local concern into the standard. The two extension-side
  probes keep their own copies by construction, and the module now says so instead of overclaiming.

  Presence questions require PROOF (`=== "alive"`); only destructive questions preserve on doubt
  (`!== "dead"`, which is why `down.ts` is written that way and is untouched). An earlier revision of
  this change had the presence sites preserving too, and review reproduced what that buys: a permanent,
  silent, retry-proof false-up, where the control plane reports `running: true` three times over
  against an unreachable manager. The demonstrated defect was `EPERM` alone, and widening past it was
  unforced.

  Covered by a new broker-free suite, `smoke:pid-contract`. The errno-to-state mapping is a pure
  exported function tested exhaustively, so there is no fixture to skip: the first revision reached the
  `EPERM` rule only by probing pid 1 and hoping the process was unprivileged, and as root or in a
  container that cell skipped while the suite still printed a passing banner over a deliberately broken
  implementation. The suite also drives the CONVERTED CALLERS through real pidfiles, because the first
  revision tested only the primitive and a reviewer inverted all five call sites without reddening a
  single check.

  `unknown` is REACHABLE on a real kernel, not merely under a test shim. A Linux seccomp
  `SECCOMP_RET_ERRNO` filter, or an LSM policy through `security_task_kill()`, can answer
  `kill(pid, 0)` with an arbitrary errno without executing it, and libuv preserves it. Review proved
  this with a live seccomp BPF filter and no interposition. So both ways of folding the third state
  into a boolean are wrong, and both fail SILENTLY: preserving reports a control plane that is not
  there and no retry clears it, while requiring proof launches a second manager over one that may be
  live.

  `ensureManager` and `ensureDelivery` therefore REFUSE on `unknown`, loudly, naming the pid, naming
  seccomp/LSM as the expected cause inside sandboxes, and saying what to check. `managerLiveness` and
  `deliveryLiveness` expose the state the booleans cannot carry; `managerUp`/`deliveryUp` remain
  `=== "alive"` for display, with a doc note sending any caller that ACTS on the answer to the
  tri-state.

  Honest coverage limit, stated in the suite's own output rather than implied away: no cell here
  exercises `unknown`, because no `parsePid`-accepted input produces one from this process. The refusal
  is verified by a seccomp BPF harness outside the suite.

- a74a768: Sandbox the temp root in the smokes that mint a mesh fixture there, so a `.cotal` left above the temp base (`/tmp/.cotal` on Linux CI runners) can no longer capture the fixture and make a suite grade a live mesh. One shared implementation in `bin/smoke/_scratch.ts`, used by `spawn-from-anywhere`, `down-target`, and both `ps` suites. The dead-manager cells now assert that the manager was found, was alive, and is dead, instead of skipping their own kill when the pid file is missing.
- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [2768f5b]
- Updated dependencies [019afc3]
- Updated dependencies [3539f20]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [14ff831]
- Updated dependencies [11cd652]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0
  - @cotal-ai/workspace@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [531d37d]
- Updated dependencies [498055c]
  - @cotal-ai/workspace@0.16.0
  - @cotal-ai/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f89560a]
  - @cotal-ai/core@0.15.0
  - @cotal-ai/workspace@0.15.0

## 0.14.11

### Patch Changes

- @cotal-ai/core@0.14.11
- @cotal-ai/workspace@0.14.11

## 0.14.10

### Patch Changes

- @cotal-ai/core@0.14.10
- @cotal-ai/workspace@0.14.10

## 0.14.9

### Patch Changes

- Updated dependencies [a4c082a]
  - @cotal-ai/workspace@0.14.9
  - @cotal-ai/core@0.14.9

## 0.14.8

### Patch Changes

- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8
  - @cotal-ai/workspace@0.14.8

## 0.14.7

### Patch Changes

- Updated dependencies [12ad5e3]
  - @cotal-ai/workspace@0.14.7
  - @cotal-ai/core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- @cotal-ai/core@0.14.5
- @cotal-ai/workspace@0.14.5

## 0.14.4

### Patch Changes

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

### Minor Changes

- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.

### Patch Changes

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
