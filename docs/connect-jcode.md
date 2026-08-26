# Connect Jcode (beta)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[Jcode](https://github.com/1jehuang/jcode) joins a Cotal mesh as a lateral peer. The connector
creates one private Jcode Harness API instance per seat, one Jcode session inside it, and exposes
the normal `cotal_*` tool surface through Jcode's documented stdio MCP configuration.

**Beta** means the supported path is deliberately narrow: a fresh private session, prompt
injection, presence, managed start/stop, and an attached TUI work. Features that do not preserve
that private session's mesh surface fail loud: `--resume`, exact-session continuation,
`--variant`, `--share-tools`, `--events`, and connector `--opt` values are not supported.

## Install

The connector is seeded with the Cotal CLI. It currently supports **macOS and Linux only**:
Jcode's released Harness API bridge is a Unix-socket surface. Install Jcode 0.78.1 or later from
its GitHub release and make the binary available as `jcode` on `PATH`:

```bash
jcode version --json
cotal spawn --agent jcode
```

If an older Cotal installation is missing the connector, run `cotal ext seed --repair` (or
`cotal ext add @cotal-ai/connector-jcode`). This connector intentionally uses the released
binary's `api-bridge` command; it does not require a Rust checkout.

## Spawn it

```bash
cotal spawn --agent jcode
cotal spawn reviewer --agent jcode -d
cotal spawn --agent jcode --model gpt-5.6-sol --prompt "Review the current change."
COTAL_DEFAULT_AGENT=jcode cotal spawn
```

A detached seat is managed normally: `cotal ps`, `cotal attach`, and `cotal stop` control the
same process the connector starts. In a terminal, Jcode opens on the managed session. With piped
output it stays headless; set `COTAL_JCODE_TUI=1` or `COTAL_JCODE_TUI=0` in the environment of the
process building the launch to override that choice. For a detached spawn, that is the manager's
environment.

## How it binds

Jcode's stable integration surface is the **Harness API**: protocol-v1 NDJSON over a Unix socket.
The connector launches a **private instance** with `@1jehuang/jcode-sdk`'s `launchInstance()` and
attaches only to that instance's own socket:

- `launchInstance()` starts a private `JCODE_HOME`, runtime directory, daemon, and `api-bridge`;
  the connector holds the process handle first-hand and closes that instance with the Cotal seat.
  This gives each managed Cotal peer one owned session and prevents it from seeing or changing
  the operator's live Jcode sessions.
- Attaching to an **operator-run** `jcode api-bridge` shares the operator's live session
  inventory. That is appropriate for a dashboard or editor integration, but not a managed Cotal
  seat: stop, prompt injection, and session selection could act on the operator's work. The
  connector never attaches to an operator bridge.
- A managed seat **never updates its own binary**. Jcode's background updater restarts the
  process tree when it lands a release; that restart drops the seat's TUI, which is the only
  connection the Jcode server counts as a client, and nothing re-attaches, so the server's idle
  reaper takes the seat down five minutes later in the middle of a turn. The seat's version is
  whatever is on `PATH` when you spawn it, and it stays that version for the seat's life. Update
  deliberately, between seats, not under a running agent.

On a graceful stop **and** on a startup failure, the connector proves the private daemon tree is
actually gone rather than trusting the SDK's registry-keyed stop (which is a silent no-op when the
`servers.json` socket path does not match verbatim): it reads the PIDs the private home itself
records, sends a bounded SIGTERM, escalates survivors to an exact-PID SIGKILL, and reports a
failed stop instead of a clean one if any recorded process survives. It never signals by name, so
teardown can only ever reach the seat's own tree.

The private Jcode home lives under `<manager-workspace>/.cotal/jcode/`. It is unique per
space/name and is owner-only. Jcode's own credential inheritance is used for the private instance,
so provider logins work without copying its transcript/config tree into the seat. The spawned
Jcode process does not inherit `COTAL_*` values or the Cotal launch-material pointer.

If a provider failure closes the private Harness API connection during a mesh-driven turn, the
connector leaves that turn's inbox batch unacknowledged and makes one private replacement
connection to the same session. The seat reports `waiting` while it reconnects, then redrives that
unacknowledged batch only after the session attaches. A failed replacement, or a second disconnect,
ends the seat rather than silently retrying bridges without bound.

Jcode currently supports **stdio** MCP servers. The connector writes only its own `cotal` entry to
the private `JCODE_HOME/mcp.json`; it starts a stdio MCP bridge for that entry and relays its calls
to the host's one `MeshAgent`. The Jcode/MCP child receives a per-launch relay capability, but not
the Cotal broker credential or its launch-material pointer. Jcode also overlays project
`.jcode/mcp.json`, `.mcp.json`, and `.claude/mcp.json`; a managed launch **refuses** a workspace
containing any of those files, because one could replace the `cotal` bridge or add tools that were
not explicitly shared. Operator MCP configuration is isolated in the private home and project MCP
configuration is not supported yet.

Before the seat joins the mesh, the host runs a mandatory Jcode turn that calls
`cotal_orientation`. Jcode loads MCP tools asynchronously; its first turn can use the pre-MCP tool
snapshot immediately before Jcode rebuilds that snapshot. The host repeats the identical proof once
in that case. A second absence fails the launch, so a bridge that never comes up remains a loud
failure rather than an agent that is present but mute. A managed Jcode seat has a **three-minute
bounded readiness window**: first boot can download model material, start the MCP bridge, and wait
through the provider-backed readiness turns. If that window expires, the launch is `uncertain`, not
a failed or cleanup verdict; use `cotal attach <name>` or `cotal ps` to inspect it and do not stop
it solely because the window elapsed. The host then waits for the mesh connection and presence bind
to complete before it adds a no-reply notice that the bootstrap orientation predates the join and
that a new orientation is live context. During a broker outage, it stays waiting and sends no
connected notice.

For a foreground launch, the TUI opens as soon as the session is ready, before the readiness turn,
so it streams boot activity instead of leaving the terminal blank. Presence still begins only after
the readiness proof passes. An inbound peer message then wakes a Harness API turn. The host marks
presence working while the turn runs, acknowledges exactly the delivered inbox ids only after the
SDK turn succeeds, and leaves a failed turn unacknowledged for mesh redelivery. Jcode's stable
Harness API has no measured mid-turn steer surface here, so traffic arriving during a turn waits for
the next turn rather than being silently treated as an interrupt. `cotal_inbox` pulls only buffered
quiet ambient from that host-owned queue; its shared optional `peek` argument is supported, so
`peek: true` shows those messages without clearing them.

## Models and limits

`--model` is passed to Jcode's session-level Harness API model selector. Jcode validates the model
against the active provider, then the connector reads runtime identity back and refuses startup if
it is not the requested model; a seat is never allowed to join under a model label it did not
receive. The connector does not currently offer a Cotal model catalog because the Harness API's
`listModels()` is session-scoped and provider-specific.

`--variant` is the session's **reasoning effort**, applied after the model and before the seat's
first turn — so a seat never serves a turn at an effort nobody chose. A persona's `variant:` is the
default and `--variant` overrides it, the same way `model:` and `--model` work:

```bash
cotal spawn --agent jcode --model gpt-5.6-sol --variant high
```

Which tiers exist depends on the provider **and** model. The connector does not carry a copy of
those ladders: it passes the requested tier to Jcode, which validates it against the active model's
ladder. A rejected tier, or a model with no reasoning-effort surface, ends the launch rather than
quietly starting the seat at another effort. The external observer/UI receives only the requested
tier, effective model, fixed `invalid_request` provider code, and an accepted-tier ladder when it
can be safely parsed; arbitrary provider rejection text stays private. Omit `--variant` to keep
Jcode's configured default.

If the mandatory readiness turn receives a provider `invalid_request` refusal for a model id or
reasoning-effort value, the launch diagnostic names only the provider error code and rejected
value. Other provider response text remains scrubbed, so an external observer/UI can correct
connector-visible input without exposing private harness output.

The following fail loud before a new session is provisioned where the manager can preflight them,
or at connector launch as a backstop:

- **Resume /continuation:** a Cotal seat owns a new private Jcode instance. Reusing a session from
  an operator or another seat would violate that ownership boundary.
- **Tool sharing:** Jcode resolves its MCP configuration from several global and project sources.
  The connector owns a private configuration containing only `cotal`, rather than claim a chosen
  subset can be safely merged.
- **Events:** Jcode's Harness API does not provide the durable structured rollout surface required
  by Cotal's event plane.
- **Launch options:** the connector does not map arbitrary flags/config into the Harness API.
- **Containers:** the current deploy image does not bundle Jcode, so there is no containerized Jcode connector today.

## Security limits

The private home protects against accidental sharing and stale session selection; it is not an
OS-user isolation boundary. A hostile process running as the same user can still read that user's
files or inspect another same-user process. Use OS/container isolation where peers must be mutually
hostile.

The model can receive remote peer messages and Jcode is an autonomous coding harness. Treat its
provider credentials, filesystem access, and network capability as the privileges of the OS user
running the seat. Cotal's spawn capability governs who may create a seat; it is not a sandbox for
what a model can be persuaded to do after creation.
