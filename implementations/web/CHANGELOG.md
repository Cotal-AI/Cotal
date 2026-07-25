# @cotal-ai/web

## 0.14.5

## 0.14.4

## 0.14.3

### Patch Changes

- fce3199: Report which machine an agent runs on, and fix three defects that only appear once a mesh spans hosts.

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

  **A timed-out request killed the whole dashboard.** `cotal web` passed an async listener to
  `createServer`, so a rejection inside any route (for example a JetStream call timing out against a
  slow broker) became an unhandled rejection and took the process down on the first slow request.
  The dashboard is a read-only observer: a failing route now returns 500 and the server stays up.

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

### Patch Changes

- 6960658: The web dashboard now ships and versions with the `cotal-ai` binary. Previously `@cotal-ai/web` was fetched separately on its own version line, so upgrading the CLI (`npm i -g cotal-ai@new`) left the dashboard stale, and the documented `cotal ext add @cotal-ai/web` could not cross the 0.x caret to reach the new release, leaving customers on an old dashboard with no clean way forward.

  web is now a bundled first-party extension alongside the connectors: it is carried inside the `cotal-ai` package and the boot reconcile installs and version-refreshes it from that bundled payload at the binary's own version. So `npm i -g cotal-ai@X` brings the dashboard to X automatically and offline on the normal upgrade path, exactly like the connectors (a deliberate operator pin or a rollback is the operator's choice, same as any connector). To make this possible, web is repackaged to be self-contained — its marked/DOMPurify browser builds are copied into its own `dist` and served from there instead of resolving `node_modules` at runtime — so it seeds with no runtime dependencies.

  The bundle path is hardened so the update stays clean and verifiable: the prepack asserts every seeded payload's `name` and `version` match the umbrella (the `fixed` group keeps them lockstep), the reconcile verifies each (re)installed extension is recorded, on disk, and at the generation version before it stamps success (a version-skewed payload fails loud), and web publishes a `vendor-manifest.json` (name/version/license/sha512) of its bundled marked/DOMPurify so the shipped browser libs stay auditable.

## 0.13.1

## 0.13.0

### Minor Changes

- d15b357: Substantially improve the observability dashboard: Markdown rendering in message
  bodies (with expand/collapse-all), attention (dnd/focus) and per-channel
  quiet/muted indicators, channel replay + delivery-class shown at a glance and in
  detail, model·variant + harness badges on the roster and graph, richer graph
  node cards (agent description/tags, channel durability), resizable sidebars and
  nav sections, and assorted layout/legibility fixes.

  Adapt the observer tap for v0.4: subscribe the messaging planes (chat, inst, svc)
  individually instead of the space-wide `>`, so the dashboard no longer taps the
  v0.4 endpoint request rails.

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

## 0.11.3

### Patch Changes

- Version alignment: `@cotal-ai/web` joined the workspace's fixed release group, so its version now tracks the rest of the packages. It had lagged at 0.11.1 while the group reached 0.11.3; this republishes it at 0.11.3 to close the gap. No functional changes.

## 0.11.1

### Patch Changes

- 93fd521: Add the installable Orca runtime, registry-driven extension providers and local-process lifecycle,
  selective shutdown, and `cotal endpoints` for the complete live presence roster.

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

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.
