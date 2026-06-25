# Demo 1 — Lateral Coordination

Role-specialized endpoints join **one shared space** and coordinate **laterally** —
presence, addressing, and messaging — on a local NATS/JetStream mesh, each participant
in its own terminal.

It's **configurable, not hardwired**: Cotal provides the primitives (addressability,
presence, a control plane, data sharing); the *topology* — who's "planner" vs "reviewer",
who delegates to whom — is just how you set it up.

<p align="center">
  <img src="../../assets/multicast.webp" width="250" alt="multicast — broadcast to a channel">
  <img src="../../assets/unicast.webp" width="250" alt="unicast — direct message one peer">
  <img src="../../assets/anycast.webp" width="250" alt="anycast — reach any one of a role">
</p>
<p align="center"><sub><b>multicast</b> broadcast to a channel&nbsp; · &nbsp;<b>unicast</b> DM one peer&nbsp; · &nbsp;<b>anycast</b> reach <i>any one</i> of a role</sub></p>

> **Status:** the **walking skeleton** (manual CLI peers), the **control plane** (manager +
> `pty` runtime + web console), and the **Claude Code adapter** run today — `cotal start --agent
> claude` spawns a real Claude session that joins the mesh, flips presence from its lifecycle
> hooks, and wakes on incoming peer messages.

## What it demonstrates

- **Join in one command** — an endpoint joins a space and appears in presence.
- **Presence & discovery** — see who's present, their role, and live state
  (`idle` / `waiting` / `working` / `offline`).
- **Addressability** — all three delivery modes: **multicast** (broadcast to a channel),
  **unicast** (DM one peer), and **anycast** (reach *any one* of a role).
- **Live state** — watch a peer flip to `working` / `waiting` and back.
- **Observability** — a read-only `watch` endpoint tails everything on the mesh.
- **Graceful leave / drop** — a peer that quits (or whose heartbeat lapses) shows `offline`.
- **Late join** — a peer joining late immediately sees the current roster (presence snapshot).

## Prerequisites

- Node ≥ 20, pnpm, and `nats-server` (v2.11+). macOS: `brew install nats-server`.
- Install deps once, from the repo root: `pnpm install`.

## Run it

**1. Start the mesh** (one terminal — stays running):

```
pnpm cotal up --open --channels examples/01-lateral-coordination/channels.json
```

If a nats-server is already listening on `:4222`, Cotal detects it and reuses it. The
optional `--channels` file seeds the channel registry (per-channel replay policy +
descriptions); edit it live with `cotal channels set <name> [--replay|--no-replay] [--desc …]`.

**2. Join as a few peers** (one terminal each):

```
pnpm cotal join --space demo --name alice --role planner
pnpm cotal join --space demo --name bob   --role builder
pnpm cotal join --space demo --name carol --role reviewer
```

**3. Watch everything** (optional — one terminal):

```
pnpm cotal console --plain --space demo
```

## Or: let the manager spawn peers

Instead of opening a terminal per peer, run the **manager** and drive it over the control
plane. The manager owns each peer's process in a pseudo-terminal (`pty` runtime).

```
# one terminal — the supervisor (composition root: picks the cotal + claude connectors)
(cd examples/01-lateral-coordination && pnpm manager)

# then, from anywhere
cotal start --space demo --name alice --role planner   # manager spawns alice in a PTY
cotal ps    --space demo                                # list managed peers + mesh status
cotal attach --space demo --name alice                  # stream + drive her terminal (Ctrl-] detaches)
cotal stop  --space demo --name alice                   # kill the process
```

`cotal start --agent claude` spawns a real Claude Code session the same way (see below).

## Watch them in the browser — CLI + manager + web console

The manager hosts a **console** (in-process, loopback) — a lightweight xterm.js page that
shows one live terminal per managed agent. PTY bytes stream over a direct WebSocket (the same
stream `cotal attach` consumes), never the mesh. One example, all three surfaces together:

```
pnpm cotal up --open                                       # 1. mesh, unauthenticated (terminal stays running)
(cd examples/01-lateral-coordination && pnpm manager)      # 2. manager + console → prints http://127.0.0.1:7878/

# 3. drive it from the CLI — the console updates live
pnpm cotal start --space demo --agent claude --name ada   --role planner
pnpm cotal start --space demo --agent claude --name linus --role reviewer
```

Open **http://127.0.0.1:7878/** — two panes appear, each a real Claude Code TUI you can type
into. `cotal ps` / `stop` / `start` from any terminal and the grid reconciles (panes added,
removed, status dot flips green→red on exit). Port: `COTAL_CONSOLE_PORT` (default `7878`).

## A Claude Code agent joins as a peer

A real coding agent joins through the **manager** — `cotal start --agent claude` does the native
launch in a PTY pane (no wrapper in front, an ordinary Claude session):

```
# one-time, per machine: install the bundled plugin for this repo only
claude plugin install cotal@cotal-mesh --scope local

cotal start --space demo --agent claude --name dave --role builder   # manager spawns a real claude
```

### Personas from a file

Role + identity + a persona can come from an [agent file](./agents/) instead of flags — the
frontmatter is the identity, the Markdown body is the system prompt:

```
cotal start --agent claude --name dave --config examples/01-lateral-coordination/agents/dave.md  # manager, detached PTY
cotal spawn --agent claude --name dave --config examples/01-lateral-coordination/agents/dave.md  # foreground, in this terminal
cotal spawn dave                                                                                 # …or the shorthand (./.cotal/agents/dave.md)
```

A bare `cotal start --name dave` also auto-discovers `.cotal/agents/dave.md` in the manager's
workspace (gitignored, user-local). See [agent files](../../docs/claude-code-integration.md#agent-files-persona--identity).

The bundled plugin reads `COTAL_*` from the env at spawn and auto-joins the mesh; the manager
auto-clears the one-time dev-channel prompt, so the launch is hands-free. From there the agent is
a peer like any other: its presence flips `working` / `idle` from lifecycle hooks, and mesh
messages reach it two ways — **hook injection** at turn boundaries (the spine) and a **channel
nudge** that wakes it the instant a message arrives while idle. See
[claude-code-integration.md](../../docs/claude-code-integration.md) for the launch / install /
channel mechanics, and [architecture.md](../../docs/architecture.md) for the surface mapping.

## Inside a `join` session

Type a line to broadcast it to the channel. Commands:

| Command | Effect |
|---|---|
| `/who` | show the roster (names, roles, states) |
| `/dm <name> <msg>` | unicast a direct message to one peer |
| `/anycast <role> <msg>` | anycast — reach *any one* instance of a role |
| `/working [what]` | set your state to `working` (+ optional activity) |
| `/waiting [why]` | set your state to `waiting` |
| `/idle` | set your state to `idle` |
| `/me <activity>` | update your activity text |
| `/quit` | leave (others see you go `offline`) |

## A scripted run-through

1. Join as `alice` and `bob` in two terminals — each sees the other join.
2. `alice`: type `kicking off the auth refactor` → `bob` sees it on `#general`.
3. `alice`: `/working auth refactor` → `bob`'s roster shows `alice ● working`.
4. `bob`: `/dm alice on it — taking the tests` → `alice` gets a direct message.
5. A late `carol` (reviewer) joins → immediately sees the current roster.
6. `alice`: `/anycast reviewer take a look at the diff` → exactly one reviewer (carol) gets it.
7. Quit `bob` (`/quit` or Ctrl-C) → `alice` sees `← bob went offline`.

## Quick self-test

```
pnpm smoke
```

Runs a non-interactive end-to-end check against a running mesh: two endpoints exchange a
broadcast and a DM, observe a `working` state change, and detect `offline` on leave.

## Runtime options

The manager defaults to `pty`. To spawn agents into a **tmux window** or **cmux tab** instead,
import the matching extension in the composition root and select it at launch:

```bash
# tmux — each agent gets its own window in the cotal session
cotal supervise --runtime tmux   # requires: import "@cotal-ai/tmux" in the composition root

# cmux — each agent gets its own tab
cotal supervise --runtime cmux   # requires: import "@cotal-ai/cmux" in the composition root
```

With `--runtime tmux` or `--runtime cmux` and the matching package not imported, the manager
throws a clear `"import @cotal-ai/<runtime>"` error — no silent fallback to pty.
