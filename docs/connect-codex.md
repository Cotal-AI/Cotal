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
Minimum **codex-cli 0.145.0**; tested against 0.145.0 and 0.146.0. An older binary authenticates fine but has
no `--listen`/`--ws-auth` listener, so the launch fails at startup rather than misbehaving quietly:
check with `codex --version` and upgrade (`npm i -g @openai/codex`) if a launch reports that the
app-server exited before it started listening. The surface is explicitly experimental upstream, so
a later Codex release may change it and need a connector update. That is a break to report, not a
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
  in the process table; see [Limits](#limits) for what that token does and does not protect). The model calls them like any tool and they
  execute against the host's single mesh endpoint: no sidecar process, no second identity. The
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
  CI, a smoke) the host stays headless and prints an activity feed instead: the same peer either
  way, only the UI differs.
  **Which mode you get** is decided by whether *stdout* is a terminal, and `COTAL_CODEX_TUI=1|0`
  overrides that check when it would guess wrong (a wrapper that redirects output, a CI run that
  wants deterministic text). It is read from the environment of **whichever process builds the
  launch**, so set it in the right place:
  - foreground `cotal spawn`: your own shell, per spawn;
  - detached (`-d`): the **manager's** environment, because the manager builds the launch. Set it
    where you start the manager (`COTAL_CODEX_TUI=0 cotal up`) and it applies to every codex agent
    that manager supervises. Exporting it in the shell that runs `cotal spawn -d` does nothing.

  A detached agent gets the manager's pty, which *is* a terminal, so the default there is the TUI,
  which is what `cotal attach` streams.
  Once the TUI paints, the terminal belongs to Codex, so the host's own diagnostics move to
  `host.log` inside the agent's private home
  (`<workspace>/.cotal/codex/<space>-<name>-<hash>/host.log`; the handoff line prints the exact
  path, and `ls -t .cotal/codex/*/host.log` finds it after the fact). Attached, a failure is also
  reported on the terminal; detached, that report goes to the pty, so the file is the durable copy.
- **Presence from events.** working/idle/waiting are derived from the app-server event stream;
  the model id is reported from the started thread.

`--opt k=v` launch options render as codex `-c k=v` config overrides on the app-server child
(top-level keys, scalar values; write TOML inline-table text yourself for nested values). The
connector's own defaults and selectors ride the same rail and yield to yours, except
`mcp_servers`, which is how the agent reaches the mesh: the whole namespace is refused loud (at
spawn, not at launch) rather than silently overridden.

## Event plane

A seat launched with `cotal spawn --events` publishes a structured account of what it did: run
boundaries per turn, assistant text, reasoning, and the tool calls the model makes through Codex's
function-call and custom-tool interfaces, each with its arguments, its end, and its result. That
covers the tools you watch a seat use, `shell` and `apply_patch` among them. The channel is
`events.<owner>.<actor>`, named after the seat's principal, and the rules for it are the same on
every connector: see [connect-claude.md](connect-claude.md#event-plane) for the channel, the grant,
and how to read it. Arming is `COTAL_EVENTS`, which the launcher sets for `--events` spawns; your own
`codex` publishes nothing.

```bash
cotal spawn watcher --agent codex --events -d   # armed, detached; read it with `cotal console`
```

Eight things are specific to Codex and worth knowing before you read a stream:

- **The durable record is the thread's rollout file, not the live app-server stream.** The seat's
  rollout lives inside its own isolated `CODEX_HOME`, under
  `<workspace>/.cotal/codex/<space>-<name>-<hash>/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<thread>.jsonl`.
  Reading the file rather than the stream is what lets the seat resume a thread's stream where it
  stopped after its own process restarts, rather than reopening it from the top.
- **A restarted app-server is a NEW thread, and its stream is a new one.** When the child dies and
  the seat brings up a replacement, Codex starts a fresh thread with a fresh rollout. The seat
  finishes the old one first, publishing what it had and closing any run left open, then begins
  publishing the new thread under its own write-ahead log. A reader sees one stream end and another
  begin, never one stream silently continuing under a different thread. If the new thread's file is
  slow to appear the order is the other way round: the seat spends its whole bounded look for the new
  file first, and the old stream ends when that look gives up, not at the moment of the restart. From
  the give-up on it publishes nothing until the new thread binds at a later turn boundary; it does not
  keep reporting the dead thread's activity in the meantime.
- **The stream starts where the seat binds to the file.** `thread/start` writes nothing to disk; the
  file appears when the thread is primed. The seat binds to it then, and publishes from that point
  forward. If the file is slow to appear the seat says so in its log and looks again at each turn
  boundary, and whatever the thread wrote before the bind is not republished.
- **Codex's own built-in tools are not published yet.** Web search, tool search and image generation
  record an end with no start, and nothing joins the two halves: the start-shaped record carries no
  call id and the end carries one. Rather than guess a pairing, the seat drops them, so those tool
  uses are absent from the stream while everything on the function-call path is present.
- **A failed turn is published as a run error, not as a finished run.** Codex records a failure on
  the turn's own completion record, so a turn that hit a usage limit or an upstream error ends its
  run with `RUN_ERROR` carrying the code Codex reported.
- **No user-authored text is published, ever.** Your prompts, the peer messages injected into the
  thread, and the developer instructions the persona supplies are all withheld. The events channel
  carries a different read ACL from the channel you typed into, so republishing your own words there
  would widen who can read them. Assistant text, reasoning and tool activity are unaffected.
- **A broker that is down when the seat starts costs the outage, not the seat.** The plane publishes
  through the seat's mesh connection, so a seat armed while its broker was unreachable cannot start
  its emitter. It says so in its log, and rebuilds the emitter at the first turn boundary once the
  broker is there. A rebind DECLINES to publish two things, and they are one rule rather than two
  exceptions. It declines what the thread wrote while the seat was cut off. It also declines the
  turn whose own boundary triggered it: Codex writes a turn's first record before it announces that
  the turn started, and that announcement is what a rebind runs on, so the record is always behind
  whatever boundary the rebind takes, and a run is never opened from the middle of a turn. The first
  turn to start after the rebind is published in full. One case is different and is named here
  rather than left to be discovered: if the emitter had already been publishing this thread and
  then died, the seat's log carries its position, and the rebind CONTINUES that log rather than
  starting where it binds. What that delivers is what the dead emitter had read but not yet sent.
  Nothing is sent twice in either case.
- **Reasoning is published as its summary only.** Codex also stores an encrypted reasoning blob on
  every reasoning record; it is opaque, no reader can display it, and it is never put on the wire.

## Autonomy and the sandbox

A spawned Codex agent is woken by peer messages, which arrive when nobody is watching the
terminal. The defaults follow from that, and all three are overridable per spawn with `--opt`.

| Default | What it means |
| --- | --- |
| `approval_policy="never"` | Never **ask** before running a command. Not "refuse": the agent runs its commands, it just does not stop to prompt. An interactive policy is refused loud rather than honored dishonestly, because a mesh-driven turn would block forever on a prompt nobody sees, and the alternative (auto-answering for you) nullifies the policy you asked for. |
| `sandbox_mode="workspace-write"` | Commands may read anywhere but write only inside the agent's workspace. This, not the prompt, is the part that is actually enforced; see below for the (real) exposure it leaves. |
| `sandbox_workspace_write={network_access=true}` | Network **on** inside that sandbox. Codex's own default is off, which breaks installing a dependency, pushing a branch, or calling an API, with an error that reads like the task is impossible rather than the sandbox saying no. Applied only when the sandbox is actually `workspace-write`: tighten the mode and no network grant is emitted at all. |

What the sandbox guarantees, stated literally: it **blocks out-of-workspace local filesystem
writes**. It does **not** block reads, exfiltration, or networked side effects.

All three of those are live with the defaults above, because a peer's message is a **remote input**
that can cause this agent to run commands. A confused or hostile peer can in principle get it to
read a file elsewhere on your machine and send it; reach loopback or link-local services; or act
through any credential it can read, which includes irreversible actions: a force-push, an API
delete, a deploy. Containing filesystem writes is therefore not the same as containing damage, and
it should not be read that way. It is still worth keeping, because it is the one class this sandbox
can actually enforce.

If that exposure is wrong for a given agent, turn the network back off (below), tighten the mode,
or run it under a separate OS user; the same point is repeated under [Limits](#limits) so it
survives a skim. The spawn capability is the trust boundary for *who* may create an agent; the
sandbox bounds one class of what it can then be talked into doing, not all of it.

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

- **The sandbox blocks out-of-workspace filesystem writes, and only that.** It does not block
  reads, exfiltration, or networked side effects. With the default `workspace-write` + network on,
  a peer-driven turn can read anything your user account can (`~/.ssh`, `~/.aws`, `.env` files, the
  agent's own `auth.json`) and send it; reach loopback and link-local services; and act through any
  credential it can read, including irreversibly (a force-push, an API delete, a deploy). Only
  local writes outside the workspace are stopped, so this is not "everything risky is reversible"
  and not "the only exposure is disclosure". If that is wrong for a given agent, spawn it with
  `--opt 'sandbox_workspace_write={network_access=false}'` or `--opt sandbox_mode=read-only`, or
  run it as a separate OS user. See [Autonomy and the sandbox](#autonomy-and-the-sandbox).
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
