# @cotal-ai/manager

## 0.6.0

### Minor Changes

- a910ddb: refactor(cli): declutter the command surface (27 → 20 commands)

  Trims the `cotal` CLI to 20 commands with no capability lost:

  - `dm` / `msg` / `ask` are now subcommands of one dispatcher — `cotal send <dm|msg|ask>`. Subcommands avoid the shell-comment hazard of a `#channel` sigil; completion offers the sub-verbs, then the declared channels/roles.
  - `watch` (a literal alias of `console --plain`) is removed — use `cotal console`.
  - `signer` is folded into `cotal mint --signer`.
  - The `cmux` command is retired; its runner role moves to `cotal supervise --runtime <pty|tmux|cmux>`. Onboarding (`cmux go`) was a dev-clone-only duplicate of `cotal setup`/`go`, so it is dropped.
  - `demo` is hidden from help and completion (still runnable) via a new `hidden?` flag on the `Command` contract.

### Patch Changes

- Updated dependencies [a910ddb]
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
