# cotal-ai

## 0.8.0

### Minor Changes

- 3f20528: Add `@cotal-ai/tmux` — tmux Runtime and TerminalLayout extension.

  Each agent spawned via `--runtime tmux` gets its own window in a shared per-space tmux session,
  with P3 `env -i` isolation. A `TerminalLayout` provider lets `cotal setup` open and close tmux
  windows from the ambient `$TMUX` session. Both self-register on import; opt in with:

  ```ts
  import "@cotal-ai/tmux";
  ```

  **Migration:** the built-in `tmux` manager runtime is removed — `tmux` is now resolved from the
  `@cotal-ai/tmux` extension, exactly like `cmux`. The default `auto` mode is deterministic `pty`;
  tmux and cmux are never auto-selected. Choose them explicitly with `--runtime tmux`/`cmux`, which
  fails loud with a clear `"import @cotal-ai/<runtime>"` error if the matching extension isn't
  imported — no silent fallback to pty. To run examples under tmux, import `@cotal-ai/tmux` in the
  composition root and pass `--runtime tmux` to `cotal supervise`.

### Patch Changes

- Updated dependencies [3f20528]
- Updated dependencies [7ea4adf]
- Updated dependencies [edccc7c]
- Updated dependencies [b2943b0]
  - @cotal-ai/tmux@0.8.0
  - @cotal-ai/manager@0.8.0
  - @cotal-ai/cli@0.8.0
  - @cotal-ai/core@0.8.0
  - @cotal-ai/cmux@0.8.0
  - @cotal-ai/connector-claude-code@0.8.0
  - @cotal-ai/connector-hermes@0.8.0
  - @cotal-ai/connector-opencode@0.8.0
  - @cotal-ai/delivery@0.8.0

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
