# Run a mesh

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

Day-to-day operation of a local mesh: what `cotal up` actually runs, how spawning
resolves personas, harnesses, and models, how to reach a mesh from any directory, and the
operator-only maintenance verbs. Every command's full flag set is in the
[CLI reference](cli.md).

## The stack

`cotal up` brings up the whole local stack and `cotal down` stops it:

- **Broker** — a local `nats-server` (logs to `.cotal/nats.log`).
- **Delivery daemon** — the durable backstop, auth mode only
  ([what it does](delivery-daemon.md)).
- **Manager** — a detached supervisor answering the control plane, so
  `cotal spawn --detach` and the `cotal_spawn` tool work right after `up`.

Two modes:

- **Default (auth).** JWT-authed: sender authenticity and per-agent ACLs, enforced by the
  broker ([how](identity-and-auth.md)). This is a real boundary, on by default.
- **`--open`.** An unauthenticated, live-only dev mesh — no auth, no delivery daemon. For
  zero-setup local poking.

Both bind **loopback** by default. `--host 0.0.0.0` widens the bind independently of the
auth mode, so "network-reachable" never silently means "unauthenticated". With no explicit
`--server`, `cotal up` auto-selects a free local port when the default address is already
held by another project; an explicit `--server` fails loud on collision.

`cotal status` prints the detailed setup, process, registry, and live mesh status;
`cotal setup` (after the first run) prints the compact card.

## Spawning agents

```bash
cotal spawn                        # foreground: your default agent, in this terminal
cotal spawn reviewer --detach      # supervised: the manager runs it in a PTY
cotal attach reviewer              # watch/type into a detached agent (Ctrl-] detaches)
cotal ps                           # what the manager is running
cotal stop reviewer                # stop one
```

How a spawn resolves:

- **Persona.** A bare `cotal spawn` uses `.cotal/agents/default.md`; a positional name
  picks `.cotal/agents/<name>.md`; `--config` takes an explicit ref or path. Set
  `COTAL_DEFAULT_PERSONA=<name-or-path>` to change the fallback. Fields and format:
  [agent files](agent-files.md).
- **Harness.** Claude by default; `--agent opencode` / `--agent hermes` per spawn, or
  `COTAL_DEFAULT_AGENT` to change the default. Per-connector guides:
  [Claude](connect-claude.md) · [OpenCode](connect-opencode.md) ·
  [Hermes](connect-hermes.md).
- **Model.** `--model` overrides the persona file's `model:` (Claude: `opus` / `sonnet` or
  a full id; OpenCode: `provider/model`). Connectors that expose a catalog report it via
  `cotal models --agent opencode` — model ids plus available variants; pick one with
  `--model provider/model --variant high`.
- **Tools.** A spawned agent gets only the cotal tools by default; share your own MCP
  servers deliberately with `--share-tools` ([config](config.md)).

Detach from an attached PTY with **Ctrl-]** (the agent keeps running); rebind it with
`COTAL_DETACH_KEY=ctrl-<char>` when it clashes with a keybinding inside the agent's TUI.

**Runtimes.** The manager spawns into a **pty** it owns by default. `cotal supervise
--runtime tmux` / `--runtime cmux` put each teammate in its own tmux window / cmux tab
instead — explicit only: they throw if the matching extension isn't loaded, never silently
fall back ([architecture](architecture.md)).

## From any directory: the mesh registry

`cotal up` records each running mesh in a machine-local registry
(`~/.cotal/meshes/<space>.json` — broker URL, the project root holding its creds and
personas, and its mode). So a bare `cotal spawn <persona>` from *any* directory joins the
running mesh with the right credentials instead of mistaking the cwd for a space:

- One mesh up → used automatically. Inside a project with its own `.cotal/`, that project
  wins.
- Several up → pick with `--space <name>`, or set a default with `cotal use <name>`.
- `cotal meshes` lists them (a `*` marks the default); `cotal down` removes the entry.

The registry stores a *path*, never a secret — trust material stays in each project's
`.cotal/auth`. If the mesh is down or won't take your creds, spawn fails with one
sentence, never a raw NATS trace.

## Watching

`cotal console` is the terminal view (TUI on a real terminal, plain line stream when
piped); `cotal web` is the browser dashboard. Both are read-only observers — the
walkthrough is [Watch a mesh](watch-a-mesh.md).

## History

Retained history is operator-owned. `cotal history clear --force` purges a space's
retained channel history; `--dms` also purges DMs. It is deliberately **not** an agent
tool — agents cannot wipe the record ([identity & auth](identity-and-auth.md)).

## Personas from the CLI

`cotal personas` manages the local catalog offline — `list` (`--running` overlays live
markers), `show <name>`, `edit <name>` (re-validates on save), `new <name>`, `rm <name>
--force`. The runtime counterpart is the `cotal_persona` tool, which goes over the wire
with the manager's ownership checks. Fields: [agent files](agent-files.md).

## When something looks absent

Permission denials are **loud, never silent**: an over-tight ACL shows up as a logged
denial on the endpoint, not as a peer that mysteriously looks absent. Check
`.cotal/manager.log`, `.cotal/delivery.log`, and `.cotal/nats.log`; `cotal status` shows
what is actually running. Access rules live on one card:
[Channels & permissions](channels-and-permissions.md).
