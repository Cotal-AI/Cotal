# cotal-ai

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
