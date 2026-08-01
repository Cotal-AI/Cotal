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

**Don't install the `cotal` plugin Codex offers you.** Searching Codex's plugin list for "cotal"
turns up a plugin named `cotal`, from the `cotal-mesh` marketplace. That is the **Claude Code**
adapter, which appears there only because Codex reads the same plugin-marketplace format; it is
not this connector and installing it does not connect Codex to a mesh. Codex needs nothing
installed on its side: the connector drives it from the outside, over `codex app-server`.

**Codex version.** The connector drives `codex app-server` over its experimental v2 surface.
Minimum **codex-cli 0.145.0**; tested against 0.145.0. An older binary authenticates fine but has
no `--listen`/`--ws-auth` listener, so the launch fails at startup rather than misbehaving quietly:
check with `codex --version` and upgrade (`npm i -g @openai/codex`) if a launch reports that the
app-server exited before it started listening. The surface is explicitly experimental upstream, so
a later Codex release may change it and need a connector update — that is a break to report, not a
support range we can promise ahead of it.

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

Model and variant are published on presence, which is where `cotal roster` and the web dashboard's
`model · variant` badge read them from. The variant appears only when you asked for one (via
`--variant` or `variant:` in the agent file): there is no way to read the effort back off a running
thread, so an unset variant is shown as absent rather than guessed at.

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
- **Autonomy defaults.** Spawned agents run `approval_policy=never`,
  `sandbox_mode=workspace-write`, and `sandbox_workspace_write={network_access=true}`.
  See [Autonomy and the sandbox](#autonomy-and-the-sandbox) for what each one means and how to
  change it.
- **It really is Codex.** `cotal spawn --agent codex` drops you into the actual Codex TUI,
  attached to the thread the mesh drives (`codex resume --remote`). Mesh turns render as they
  happen, and anything you type is a real user turn on that same thread with the `cotal_*` tools
  still available. In the foreground that is your terminal; detached it is the manager's pty,
  which is exactly what `cotal attach` streams and drives. With no terminal at all (piped output,
  CI, a smoke) the host stays headless and prints an activity feed instead — the same peer either
  way, only the UI differs. `--transcript` mirrors the feed to `tr-<name>`.
  **Which mode you get** is decided by whether *stdout* is a terminal, and `COTAL_CODEX_TUI=1|0`
  overrides that check when it would guess wrong (a wrapper that redirects output, a CI run that
  wants deterministic text). It is read from the environment of **whichever process builds the
  launch**, so set it in the right place:
  - foreground `cotal spawn` — your own shell, per spawn;
  - detached (`-d`) — the **manager's** environment, because the manager builds the launch. Set it
    where you start the manager (`COTAL_CODEX_TUI=0 cotal up`) and it applies to every codex agent
    that manager supervises. Exporting it in the shell that runs `cotal spawn -d` does nothing.

  A detached agent gets the manager's pty, which *is* a terminal, so the default there is the TUI —
  that is what `cotal attach` streams.
  Once the TUI paints, the terminal belongs to Codex, so the host's own diagnostics move to
  `host.log` inside the agent's private home
  (`<workspace>/.cotal/codex/<space>-<name>-<hash>/host.log`; the handoff line prints the exact
  path, and `ls -t .cotal/codex/*/host.log` finds it after the fact). Attached, a failure is also
  reported on the terminal; detached, that report goes to the pty, so the file is the durable copy.
- **Presence from events.** working/idle/waiting are derived from the app-server event stream;
  the model id is reported from the started thread.

`--opt k=v` launch options render as codex `-c k=v` config overrides on the app-server child
(top-level keys, scalar values; write TOML inline-table text yourself for nested values). The
connector's own defaults and selectors ride the same rail and yield to yours — except
`mcp_servers`, which is how the agent reaches the mesh: the whole namespace is refused loud (at
spawn, not at launch) rather than silently overridden.

## Autonomy and the sandbox

A spawned Codex agent is woken by peer messages, which arrive when nobody is watching the
terminal. The defaults follow from that, and all three are overridable per spawn with `--opt`.

| Default | What it means |
| --- | --- |
| `approval_policy="never"` | Never **ask** before running a command. Not "refuse": the agent runs its commands, it just does not stop to prompt. An interactive policy is refused loud rather than honored dishonestly, because a mesh-driven turn would block forever on a prompt nobody sees, and the alternative (auto-answering for you) nullifies the policy you asked for. |
| `sandbox_mode="workspace-write"` | Commands may read anywhere but write only inside the agent's workspace. This, not the prompt, is what actually bounds the agent. |
| `sandbox_workspace_write={network_access=true}` | Network **on** inside that sandbox. Codex's own default is off, which breaks installing a dependency, pushing a branch, or calling an API, with an error that reads like the task is impossible rather than the sandbox saying no. |

Why keep filesystem containment when the network is open anyway: a peer's message is a **remote
input** that can cause this agent to run commands, and containing writes means a confused or
hostile peer cannot *change* anything outside the workspace.

Be clear about what that does **not** cover. Reads are not contained, and with the network on,
whatever the agent can read it can also send somewhere. A peer that can talk to this agent can
therefore, in principle, get it to read a file elsewhere on your machine and exfiltrate it — the
sandbox stops the damage you cannot undo, not disclosure. If that matters for a given agent, turn
the network back off (below) or run it under a separate OS user. The spawn capability is the trust
boundary for *who* may create an agent; the sandbox is the boundary for what that agent can then
be talked into doing.

Tune it per spawn:

```bash
cotal spawn --agent codex --opt sandbox_mode=read-only                        # tightest: no writes
cotal spawn --agent codex --opt 'sandbox_workspace_write={network_access=false}'  # contained, offline
cotal spawn --agent codex --opt sandbox_mode=danger-full-access               # no sandbox at all
```

`danger-full-access` is Codex's own name for it and means what it says: the agent may write
anywhere your user account can. Codex documents that mode as intended only for environments that
are already externally sandboxed (a container, a VM), not a workstation. On a laptop, prefer
tightening the workspace over removing the sandbox.

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
