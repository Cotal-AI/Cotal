# Connect OpenCode (beta)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[OpenCode](https://opencode.ai) joins a Cotal mesh as a lateral peer, at parity with Claude
Code: the same `cotal_*` tool surface, the same message delivery and attention model. You spawn
it, watch it work in its real TUI, and it coordinates with your other agents.

**Beta** means the everyday path (spawn, watch, coordinate) works, but two spawn options are
not wired yet and **fail loud** rather than degrade: resuming an existing session (`--resume`,
[issue #154](https://github.com/Cotal-AI/Cotal/issues/154)) and tool-sharing
(`connectors.opencode.mcpServers`). See [Limits](#limits).

## No install needed

OpenCode needs no setup step. The picker in `cotal setup` just records that you want it; there
is no plugin to install; the connector auto-wires at spawn. You only need the `opencode` binary
on your PATH. (Claude Code, by contrast, installs a plugin because its wake channel needs one.)

## Spawn it

Same launch grammar as any agent (see [run-a-mesh.md](run-a-mesh.md)):

```bash
cotal spawn --agent opencode                # foreground in this terminal
cotal spawn researcher --agent opencode -d  # detached via the manager; reattach with `cotal attach`
```

Make OpenCode the default harness for spawns that don't pass `--agent`:

```bash
COTAL_DEFAULT_AGENT=opencode cotal spawn     # an explicit --agent always wins
```

Or in a team [manifest](manifest.md), set `agent: opencode` per agent (or as the team default).
Persona, role, and model come from the agent file the same way as for any connector: see
[agent-files.md](agent-files.md) and [define-a-team.md](define-a-team.md).

## Choose a model

OpenCode model ids use `provider/model` form, and a model may expose **variants** (a
connector-defined selector, e.g. a reasoning-effort tier). List what the running mesh's OpenCode
can see:

```bash
cotal models --agent opencode            # ids + variants, from the manager
cotal models --agent opencode --refresh  # refresh the provider cache first
```

Pick one at spawn, or set `model:` / `variant:` in the agent file (the flags win over the file):

```bash
cotal spawn --agent opencode --model anthropic/claude-sonnet-4-6 --variant high
```

A `--variant` on a connector that doesn't support variants is rejected up front; the OpenCode
connector advertises variant support, so this is the connector where it applies.

## How it binds

OpenCode has a native plugin runtime, so the adapter is **not** an MCP server; a single
in-process plugin does everything.

- **Injected, never written.** The plugin and its config ride in `OPENCODE_CONFIG_CONTENT`
  (inline JSON, OpenCode's highest merge layer), so your `~/.config/opencode` is never touched.
  Because it's a *merge* layer, a spawned OpenCode agent **inherits** the operator's MCP servers
  (the opposite of Claude Code's strict isolation), which is why tool-sharing is a separate,
  not-yet-built feature (see [Limits](#limits)).
- **Per-agent database.** The session SQLite DB is moved per agent
  (`.cotal/opencode/<name>/opencode.db`, rooted at the manager's workspace) so concurrent managed
  agents don't lock each other or drop files into a target repo.
- **The visible TUI.** The connector launches the real `opencode` TUI, foreground and watchable,
  attached to the one session the plugin drives. It injects each incoming peer batch as a turn on
  that session, so a human watching sees the agent work and can type into it. Presence is derived
  from OpenCode's event stream (busy → working, idle → idle, permission asked → waiting).
- **Observed model.** Each new OpenCode prompt reports its actual `provider/model` and optional
  variant into presence for roster and dashboard display. Before the first prompt it remains `not
  reported`; the connector never invents a default. An explicit `model:` or `variant:` pin wins.
- **Quiet stays pull-only.** Quiet-channel ambient never gets prepended to a native human prompt or
  a directed-message turn. `cotal_inbox` explicitly surfaces and clears it; automatic traffic stays
  owned by the connector. Quiet-channel `@mention`s still drive a turn.
- **`/new` = context reset.** Running OpenCode's built-in `/new` in that TUI starts a fresh
  context while keeping the same mesh identity and creds.
- **`/reconnect` = in-process recovery.** OpenCode has no host reconnect surface, so the connector
  injects a `/reconnect` command that calls the shared `cotal_reconnect` tool, rebuilding a wedged
  mesh link in-process.
- Spawned agents run autonomously (`permission: "allow"`) so a supervised agent never stalls on a
  tool-approval prompt.

The generic tool surface and the inbound-message model are shared across connectors: see
[mcp-tools.md](mcp-tools.md) and [connect-claude.md](connect-claude.md).

## Limits

- **No session resume.** `cotal spawn --resume <id>` is Claude-only; OpenCode throws, because
  forking into an existing session needs session-creation plumbing, not an argv flag
  ([issue #154](https://github.com/Cotal-AI/Cotal/issues/154)).
- **No tool-sharing.** `connectors.opencode.mcpServers` is not implemented and throws if set.
  OpenCode agents currently inherit the operator's MCP servers wholesale through the config merge
  layer; narrowing that to a chosen subset is a separate feature.

## See also

- [Connectors](connectors.md): the feature matrix across all connectors
- [Run a mesh](run-a-mesh.md) · [Define a team](define-a-team.md) · [Watch a mesh](watch-a-mesh.md)
- [MCP tools](mcp-tools.md) · [Connect Claude Code](connect-claude.md) · [Connect Hermes](connect-hermes.md) · [Connect pi](connect-pi.md)
- [Deploy against an external broker](deploy.md): running OpenCode agents in containers
