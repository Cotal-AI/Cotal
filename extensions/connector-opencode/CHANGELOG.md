# @cotal-ai/connector-opencode

## 0.24.0

## 0.23.0

## 0.22.0

### Minor Changes

- 57d3a57: A Claude session publishes a structured event plane, and the `tr-<name>` transcript mirror is
  retired

  A session launched with `cotal spawn --events` now actually publishes. The Claude connector maps
  its session records to structured events behind the same hook relay the mirror used to sit behind:
  run boundaries per turn, assistant text, reasoning, and each tool call with its arguments, its end
  and its result, written to a per-session write-ahead log before they go on the wire so a restart
  resumes at its cursor instead of replaying or skipping. Until now no connector constructed the
  emitter at all, so every event channel was empty.

  The `tr-<name>` mirror is removed in the same change rather than deprecated alongside it. Gone with
  it: the `--transcript` and `--no-transcript` flags on `cotal spawn`, the `transcript` field on the
  manager's spawn op and its service contract, `COTAL_TRANSCRIPT` and `COTAL_TRANSCRIPT_DEFAULT`,
  `LaunchOpts.transcript`, `Connector.transcriptChannel`, and the mirror in all three connectors that
  carried one.

  MIGRATION. If you read a `tr-<name>` channel, nothing publishes to it any more. A managed session no
  longer mirrors its prose there under any flag or environment variable, and a spawn that passes
  `--transcript` now fails on an unknown flag rather than being ignored. Read the session's event
  channel instead: launch with `--events` and subscribe to `events.<owner>.<actor>`, which is keyed on
  the session's principal. On a static mesh that is `events.local.<key>`, where the key is what the
  manager allocated and the spawn reply carries it as `id`; on a user-auth mesh it is
  `events.<your-owner>.<agent-name>`, where the actor half is the agent's own name. `connect-claude.md`
  gives both forms. `cotal console` and the web console render event frames directly. Unlike
  `tr-<name>`, you cannot simply subscribe: the plane needs an out-of-band grant, and the command for
  it is under "To let something read a plane" below.

  What you gain and what you lose, both stated. A tool call now arrives with its full arguments, its
  end and its result, in a vocabulary a program can read, where the mirror gave a truncated one-liner
  of glyph-prefixed text. What you lose is prompt text somebody else wrote: the mirror republished
  every prompt, and the event plane withholds the body of a turn the agent did not author, because
  republishing a peer's message onto a channel that peer may not read crosses an ACL boundary. A
  peer-authored turn still opens a run and still shows the work it caused. One stated limit on that,
  because the loss column is only useful if it is complete: a tool result is this session's own output
  and is republished, so peer text quoted inside one still reaches the wire. A cell in
  `agui-authorship.smoke.ts` holds that as a measured limit rather than leaving it to be discovered.

  A spawn may be granted the event plane of the agent it is creating, and no other. A spawn that names
  a different agent's event channel in `allowSubscribe` or `allowPublish` is refused at the door,
  because that channel carries the session's tool inputs and outputs. The same rule runs on a manager
  resume: a retained inventory naming another agent's event channel is refused rather than adopted.

  The rule reads a **concrete** channel, two principal tokens and nothing else. A pattern such as
  `events.<owner>.>` is not an event channel to it and passes untouched, governed by ordinary ACL
  authority. That is deliberate, since the pattern is the form an operator writes on purpose for an
  observer.

  To let something read a plane, grant it out of band. The refusal prints one command, spelled out in
  full, for the mesh it is running on. On a user-auth mesh:
  `cotal actor grant <reader> --owner <owner> --scope '' --allow-subscribe '<channel>' --allow-publish
''`, every field named because `actor grant` is an upsert of the whole row and an omitted flag is the
  wide default (`>` read, `>` post, `spawn,role:default` scope), not "leave it alone". On a static mesh there is no
  actor ledger for `actor grant` to write to, so mint the reader instead:
  `cotal mint watcher --profile agent --allow-subscribe '<channel>' --provision`, the agent profile and
  not the observer one, since `mint` reads `--allow-subscribe` only for that profile and refuses it off
  that profile.

  `cotal mint` now REFUSES `--allow-subscribe` / `--allow-publish` off the agent profile rather than
  ignoring them. Those profiles carry a FIXED read set, the chat plane for observer and the whole
  messaging plane for admin, so
  `--profile observer --allow-subscribe <one channel>` used to exit 0, print a success line, and hand
  out a credential that reads every channel in the space: an operator asking to narrow got the
  opposite, silently. `--role` and `--provision` were already refused there for the same reason. The
  rows in `cli.md` and the sentence in `build-a-client.md` now say the same thing.

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.0

### Minor Changes

- 4e8d776: The `cotal_*` tools now refuse an argument they do not model instead of silently
  dropping it. A call carrying an unmodelled key (`owner` or `actor` alongside the
  real arguments) previously succeeded with that key stripped before the tool ran,
  so the caller was told nothing and the tool did something other than what was
  asked. It is now refused by name, on every adapter and on every tool: the MCP
  renderers and pi publish a closed schema and the host rejects the call, while
  OpenCode and Hermes pass the caller's object through untouched and are closed at
  the connector's own dispatch. Tools that take no arguments are closed too: they
  were previously published with no schema at all, so a host had nothing to check
  against and forwarded the extras to be dropped, as is `cotal_inbox`, whose
  arguments four of the connectors replace with their own. Behaviourally breaking
  for any caller that was relying on extra keys being ignored. Every refusal names
  the rejected keys; where the connector is the one refusing it also lists the
  arguments the tool accepts, or says it takes none.

### Patch Changes

- 885c82e: `cotal spawn --agent opencode --prompt <text>` now submits that text as the session's first turn.
  The connector built its launch spec without ever reading the prompt, so an OpenCode seat accepted
  the flag, joined the roster, loaded its persona, and then sat idle until something else woke it.
  The prompt now rides the child environment to the in-process plugin, which submits it once, after
  the session exists and the mesh link is up, and never again on a later readiness event. Peer
  traffic that arrives during boot stays buffered and is delivered when that first turn ends, so the
  operator's prompt really is the first turn. An initial prompt with no text in it is refused at
  launch instead of being accepted and dropped.

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.11

## 0.14.10

## 0.14.9

## 0.14.8

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

## 0.13.1

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

## 0.12.0

### Minor Changes

- d2333f1: The OpenCode plugin bundle is now closed over its runtime dependencies, so `cotal spawn --agent opencode` works from an installed extension. It previously kept a runtime import of `@opencode-ai/plugin` (a peer that `cotal ext add` never installs), which OpenCode could not resolve; it skips such a plugin silently, so the agent never joined the mesh and the launcher sat for 60s before aborting with "agent session never came up". The only use of that import was `tool()`, an identity function for type inference, so the tool definitions are now plain `ToolDefinition` literals and the import is type-only. The `@opencode-ai/*` bundler externals are gone as well, so a future value import is inlined rather than silently escaping the bundle.

## 0.11.6

## 0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.

## 0.11.3

### Patch Changes

- @cotal-ai/connector-core@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/connector-core@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [5b2863a]
  - @cotal-ai/connector-core@0.11.1

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
  - @cotal-ai/connector-core@0.11.0

## 0.10.1

### Patch Changes

- e3a53e3: Add a connector-agnostic model/variant selector: the `cotal models` command, a `--variant` flag on spawn, and the core `listModels` / `ModelCatalog` + `LaunchOpts.variant` contract. OpenCode discovers its models and variants from the installed CLI; Claude and Hermes reject variants (fail loud) and set `COTAL_MODEL` when a model is given.
- Updated dependencies [e3a53e3]
  - @cotal-ai/connector-core@0.10.1

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
  - @cotal-ai/connector-core@0.10.0

## 0.9.1

### Patch Changes

- @cotal-ai/connector-core@0.9.1

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
  - @cotal-ai/connector-core@0.9.0

## 0.8.3

### Patch Changes

- a10ed79: OpenCode connector: mirror each agent's session transcript to its per-agent `tr-<name>` channel, event-driven from the plugin's in-process bus events (`message.updated` / `message.part.updated` / `session.idle`) — parity with the Claude connector, with no per-turn session refetch. The `tr-<name>` channel convention is exposed through the `Connector` contract (`Connector.transcriptChannel`) so the manager can grant the agent's publish ACL without the channel literal living in `@cotal-ai/core`, and the manager forwards control-plane `capabilities` (`COTAL_CAPABILITIES`) so a manifest-spawned agent exposes the `cotal_spawn` / `cotal_persona` tools its creds already authorize. Adds an end-to-end smoke for the mirror (`smoke:opencode-transcript`).
- Updated dependencies [a10ed79]
  - @cotal-ai/connector-core@0.8.3

## 0.8.2

### Patch Changes

- 58b673a: Drive OpenCode peer-message turns through the authenticated serve HTTP API for the exact attached session.
  - @cotal-ai/connector-core@0.8.2

## 0.8.1

### Patch Changes

- @cotal-ai/connector-core@0.8.1

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
  - @cotal-ai/connector-core@0.8.0

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
  - @cotal-ai/connector-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [ba5e622]
  - @cotal-ai/connector-core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [58f2d41]
  - @cotal-ai/connector-core@0.5.0

## 0.4.0

### Minor Changes

- 878f406: Context reset, local auth reuse, and reconnect for spawned OpenCode agents

  - `/new` is adopted as a context reset that keeps operator logins.
  - Spawned agents reuse local auth.
  - The busy guard releases on any turn end, so channel push survives human turns.
  - A `/reconnect` slash command (injected via `OPENCODE_CONFIG_CONTENT`) drives manual mesh
    recovery.

### Patch Changes

- Updated dependencies [878f406]
  - @cotal-ai/connector-core@0.4.0

## 0.3.2

### Patch Changes

- @cotal-ai/connector-core@0.3.2

## 0.3.1

### Patch Changes

- @cotal-ai/connector-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [df8e64c]
  - @cotal-ai/connector-core@0.3.0

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

- 73b030f: Add the `cotal_feedback` sender: a connector tool (always exposed) and a `cotal feedback "<summary>"` CLI mode. With a `COTAL_FEEDBACK_KEY` feedback routes to the keyed broker intake as before; without one it goes to the public intake at `https://cotal.ai/v1/feedback`, which requires a contact email (`COTAL_FEEDBACK_EMAIL` → git config → ask). `COTAL_FEEDBACK_URL` overrides either URL for self-hosted intakes.
- Updated dependencies [b3a790e]
- Updated dependencies [73b030f]
- Updated dependencies [739649a]
  - @cotal-ai/core@0.1.3
  - @cotal-ai/connector-core@0.2.0

## 0.1.1

### Patch Changes

- 246c9b9: Add the OpenCode connector. It launches a watchable `opencode` TUI bound to the agent's session — a headless `opencode serve` with the mesh plugin loaded, plus a foreground `opencode attach --session <id>` — drives that visible session via `session.promptAsync`, and renders the `cotal_*` tools as native plugin tools at Claude-Code parity. The tool surface is extracted into `cotalToolSpecs` in connector-core so the Claude/Codex MCP adapters and the OpenCode plugin render the same tools.
- Updated dependencies [246c9b9]
- Updated dependencies [246c9b9]
  - @cotal-ai/connector-core@0.1.3
