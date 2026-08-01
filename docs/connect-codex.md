# Connect Codex (beta)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[OpenAI Codex](https://developers.openai.com/codex/) joins a Cotal mesh as a lateral peer: the
same `cotal_*` tool surface, the same message delivery and attention model as the other
connectors, plus mid-turn steering (previously pi-only): a directed peer message arriving
mid-turn is **steered into the running turn** instead of waiting for it to end.

**Beta** means the everyday path (spawn into the real Codex TUI, coordinate, watch) works; the
spawn options that are not wired **fail loud** rather than degrade: resuming a session
(`--resume`) and tool-sharing (`connectors.codex.mcpServers`). See [Limits](#limits).

## Install

The connector ships with the CLI as a seeded extension (`@cotal-ai/connector-codex`): no
separate install step and no Codex-side plugin. You only need an authenticated `codex` binary
on your PATH (a ChatGPT-plan login or an `OPENAI_API_KEY`). If an older install is missing it,
`cotal ext seed --repair` (or `cotal ext add @cotal-ai/connector-codex`) brings it in.

**Codex version.** The connector drives `codex app-server` over its experimental v2 surface, and
is tested against **codex-cli 0.145.0 and later**. An older binary authenticates fine but has no
`--listen`/`--ws-auth` listener, so the launch fails at startup rather than misbehaving quietly:
check with `codex --version` and upgrade (`npm i -g @openai/codex`) if a launch reports that the
app-server exited before it started listening.

## Spawn it

Same launch grammar as any agent (see [run-a-mesh.md](run-a-mesh.md)):

```bash
cotal spawn --agent codex                # foreground in this terminal
cotal spawn reviewer --agent codex -d    # detached via the manager; watch with `cotal attach`
COTAL_DEFAULT_AGENT=codex cotal spawn    # make codex the default harness
```

Or set `agent: codex` in a team [manifest](manifest.md). Persona, role, and model come from the
agent file as for any connector ([agent-files.md](agent-files.md)).

## Choose a model

```bash
cotal models --agent codex               # ids + reasoning-effort variants, via app-server model/list
cotal spawn --agent codex --model gpt-5.6-sol --variant high
```

The **variant** is Codex's reasoning effort (`minimal` | `low` | `medium` | `high` | `xhigh`).
Like the `codex` CLI itself, the connector does not validate model ids or efforts locally. An
unknown value fails at request time, server-side.

## How it binds

Codex has no in-process plugin runtime and its MCP client cannot wake an idle session, so the
connector runs Codex's own client/server split: a small **host process** embeds the mesh
endpoint and drives a `codex app-server` thread over JSON-RPC (the same protocol the Codex TUI
runs on). The app-server runs as an authenticated loopback **listener** rather than a private
pipe, which is what lets Codex's own TUI attach to the very thread the mesh is driving.

- **Wake and steer.** An inbound batch starts a real turn (`turn/start`). A DIRECTED message
  (DM, anycast, @mention) arriving mid-turn is injected into the live turn (`turn/steer`);
  ambient channel chatter waits for the turn boundary so it can't derail work in flight.
- **Native tools, one endpoint.** The host serves the shared `cotal_*` tools itself, on a
  bearer-authenticated loopback MCP endpoint (the token is passed by env name, so it never appears
  in the process table — see [Limits](#limits) for what that token does and does not protect). The model calls them like any tool and they
  execute against the host's single mesh endpoint — no sidecar process, no second identity. The
  app-server is the MCP client, so the tools work the same on a turn a peer message started and
  on one **you** typed into the TUI.
- **At-least-once delivery.** A turn's surfaced messages are acked (by exact id) only when the
  turn completes. A failed turn retries with backoff, and an interrupted turn leaves the batch to
  redeliver. If the Codex app-server itself dies, the host restarts it in place (same mesh
  identity, credential, and durable) and re-drives the un-acked batch into the new thread; a
  crash *loop* (more than 3 in 2 minutes) is fatal rather than an endless respawn. (The shared
  bounded-inbox overflow rule applies: under extreme bursts an evicted in-flight id cannot
  redeliver.)
- **Isolated, never written.** Each agent gets a private `CODEX_HOME` (one hashed directory
  per space+name under `.cotal/codex/`, rooted at the manager's workspace): your `~/.codex`
  config.toml, hooks, and MCP servers never load into a managed agent, and Codex's per-project
  trust records never touch your real config. Your `auth.json` is symlinked in (re-linked each
  launch), so ChatGPT-plan token refreshes never fork. Without an `auth.json` (or an
  `OPENAI_API_KEY`) the launch fails loud at thread start. Keyring-stored credentials are not
  wired through the isolated home; use the file store or the env key for managed agents. That
  symlink is why managed Codex agents are **POSIX-only** today: on Windows without Developer
  Mode the link fails, and the launch fails loud rather than copying `auth.json` (a copy would
  fork the token and break plan refreshes).
- **Autonomy defaults.** Spawned agents run `approval_policy=never` +
  `sandbox_mode=workspace-write` so a supervised agent never stalls on an approval. Tune the
  sandbox per spawn with `--opt` (below); an interactive `approval_policy` is refused loud:
  a headless host has nobody to answer approval prompts, and would otherwise have to
  auto-answer them, silently nullifying the policy you asked for.
- **It really is Codex.** `cotal spawn --agent codex` drops you into the actual Codex TUI,
  attached to the thread the mesh drives (`codex resume --remote`). Mesh turns render as they
  happen, and anything you type is a real user turn on that same thread with the `cotal_*` tools
  still available. In the foreground that is your terminal; detached it is the manager's pty,
  which is exactly what `cotal attach` streams and drives. With no terminal at all (piped output,
  CI, a smoke) the host stays headless and prints an activity feed instead — the same peer either
  way, only the UI differs. `--transcript` mirrors the feed to `tr-<name>`.
  **Which mode you get** is decided by whether *stdout* is a terminal. Export `COTAL_CODEX_TUI=1`
  or `=0` before `cotal spawn` to choose explicitly, for when that check would guess wrong (a
  wrapper that redirects output, or a CI run that wants deterministic text).
  Once the TUI paints, the terminal belongs to Codex, so the host's own diagnostics move to
  `host.log` inside the agent's `CODEX_HOME` — the handoff line names that path, and so does any
  later failure it can still reach you with.
- **Presence from events.** working/idle/waiting are derived from the app-server event stream;
  the model id is reported from the started thread.

`--opt k=v` launch options render as codex `-c k=v` config overrides on the app-server child
(top-level keys, scalar values; write TOML inline-table text yourself for nested values). The
connector's own defaults and selectors ride the same rail and yield to yours — except
`mcp_servers`, which is how the agent reaches the mesh: the whole namespace is refused loud (at
spawn, not at launch) rather than silently overridden.

## Limits

- **Not a boundary between agents on one machine.** The app-server listener and the tool
  endpoint are both loopback-bound and token-authenticated, which keeps out other OS users and
  anything off-box. It is not isolation between *managed agents*, which run as the same user and
  can therefore reach each other's tokens; a hostile agent on your workstation could drive
  another's Codex or speak as it on the mesh. Run mutually distrusted agents under separate OS
  users or separate machines.
- **The TUI is local-only.** The app-server listener binds loopback and nothing else, so
  attaching Codex's UI to an agent on another machine needs your own SSH port-forward; there is
  no built-in remote attach. `cotal attach` (which streams the manager's pty) is the supported
  way to reach a detached agent.
- **No session resume.** `cotal spawn --resume <id>` throws: a resumed codex thread comes up
  without its configured MCP servers, so the agent would be mute on the mesh.
- **No tool-sharing.** `connectors.codex.mcpServers` is not implemented and throws if set.
- **Experimental upstream surface.** `codex app-server` is labeled experimental by OpenAI (it
  is also what the Codex TUI itself runs on). The connector pins every protocol shape in one
  driver file and re-proves the contract with a gated live smoke (`COTAL_E2E_CODEX=1`).

## See also

- [Connectors](connectors.md): the feature matrix across all connectors
- [Run a mesh](run-a-mesh.md) · [Define a team](define-a-team.md) · [Watch a mesh](watch-a-mesh.md)
- [MCP tools](mcp-tools.md) · [Connect Claude Code](connect-claude.md) · [Connect OpenCode](connect-opencode.md)
