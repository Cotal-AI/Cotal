# Agent frameworks

Besides Claude Code (see [Connect Claude](connect-claude.md)), an agent
built on an embeddable agent library can join a Cotal space as a native lateral peer. The
first such adapter:

| Extension | Framework | Language |
|---|---|---|
| `@cotal-ai/pi` | [pi coding agent](https://github.com/earendil-works/pi) | TypeScript |

It joins the same mesh as the host-bound connectors and interoperates over the same
subjects, presence, and delivery modes.

## The shape: the mesh as a host-native plugin

`@cotal-ai/pi` follows the same thin-adapter pattern as every other connector: it plugs
into the **user's own pi installation** rather than bundling a pi runtime. The whole
adapter is one pi extension file (pi's plugin mechanism) plus a `Connector` for the spawn
door. Because pi's extension discovery lives in its SDK (the default resource loader reads
`~/.pi/agent/extensions/`), the same file covers three surfaces at once:

- **`pi` interactive** — `pi --extension <file>` (or a copy in `~/.pi/agent/extensions/`)
  with `COTAL_*` env: the TUI session a human is sitting in becomes a mesh peer.
- **Spawned workers** — the `Connector` (`buildLaunch`) spawns the operator's installed
  `pi` binary (PATH resolution, like the Claude Code connector spawns `claude`; a missing
  binary fails loud) with `--extension` pointing at the packaged file. Under the manager's
  pty runtime the worker IS the real pi TUI — `cotal attach <name>` shows it.
- **Agents built on pi's SDK** — a default `createAgentSession()` discovers the same
  extension dir, so third-party pi-based agents join with no per-app work. (Apps that pass
  a custom resource loader, or forks, need their own wiring.)

Activation is opt-in by mesh identity: with no `COTAL_*` config in the env the extension
stays inert, so an installed copy never affects normal pi use; `COTAL_*` config without an
identity (`COTAL_NAME`/`COTAL_AGENT_FILE`/`COTAL_LINK`) fails loud rather than silently
running off-mesh.

## The loop: ack-on-surface off the durable inbox

Inside the extension, the shared `MeshAgent` (from `@cotal-ai/connector-core`) owns the
NATS connection, presence, and the stream-backed inbox, and the package's `InboxTurn`
drives the session off it — the inbox is the single source of truth, no parallel buffer:

1. **Inbound drives the loop.** On `"incoming"` the front-contiguous actionable batch opens
   a turn (`pi.sendUserMessage(...)` — a real user turn in the live session); actionable
   messages arriving mid-turn are folded in via `deliverAs: "steer"` (true mid-turn drive).
   Delivery is **ack-on-surface**: the surfaced run is acked only once the turn completes,
   so a crash or restart redelivers and nothing is lost. The peer is woken by DMs, anycasts,
   and channel messages according to the shared attention policy: open ambient can wake an
   idle session, while dnd/quiet ambient stays buffered for the next turn. One accepted
   residual: the extension API can't drain pi's steering queue at turn end, so a message
   steered after the loop's final poll can carry into the next turn.
2. **The model owns replies.** The full shared `cotal_*` toolset (rendered from
   connector-core's `cotalToolSpecs` via `pi.registerTool`, the same source the Claude Code
   and OpenCode adapters render) is on the session — the model replies by calling
   `cotal_dm` / `cotal_send` / `cotal_anycast`, can stay silent when no reply is warranted,
   and nothing leaves the peer that it didn't deliberately send. `cotal_inbox` is read-only
   (peek): the loop drives delivery and acking, so a drain would race the ack.

Presence is read off pi's own events (`agent_start` → `working`,
`tool_execution_start` → the running tool, `agent_end` → `idle`). pi has no permission gate
of its own, so unattended workers should be sandboxed per pi's guidance; interactively, any
pi extension that raises `ctx.ui.*` gates works as usual since the session is real pi.

Builders embedding pi's SDK directly who want the steer residual fully closed can skip the
extension and wire the same two pieces themselves — connector-core's `MeshAgent` +
`InboxTurn` (exported from `@cotal-ai/pi`) around their own `createAgentSession()`,
using `session.clearQueue()` with `InboxTurn.commitExcept` at
turn end. The extension source is the reference for everything else.

## Running

The `cotal` binary registers the pi connector like every sibling — no extra composition
root needed. It requires `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`):

```bash
export ANTHROPIC_API_KEY=sk-...   # or any pi-supported provider auth (~/.pi login works too)
pnpm cotal up
pnpm cotal spawn --detach --name pi1 --role research --agent pi
```

Or join a pi session you're sitting in by hand — no manager involved:

```bash
COTAL_SPACE=<space> COTAL_NAME=mypi COTAL_ROLE=research COTAL_ALLOW_PUBLISH=general \
pi --extension node_modules/@cotal-ai/pi/dist/extension.js
```
