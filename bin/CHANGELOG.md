# cotal-ai

## 0.6.1

### Patch Changes

- Updated dependencies [c9e9000]
  - @cotal-ai/cli@0.6.1
  - @cotal-ai/core@0.6.1
  - @cotal-ai/manager@0.6.1
  - @cotal-ai/delivery@0.6.1
  - @cotal-ai/cmux@0.6.1
  - @cotal-ai/connector-claude-code@0.6.1
  - @cotal-ai/connector-hermes@0.6.1
  - @cotal-ai/connector-opencode@0.6.1

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
