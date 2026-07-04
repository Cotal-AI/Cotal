# Agent frameworks

Besides Claude Code (see [claude-code-integration](claude-code-integration.md)), an agent
built on an embeddable agent library can join a Cotal space as a native lateral peer. The
first such adapter:

| Extension | Framework | Language |
|---|---|---|
| `@cotal-ai/pi` | [pi coding agent](https://github.com/earendil-works/pi) | TypeScript |

It joins the same mesh as the host-bound connectors and interoperates over the same
subjects, presence, and delivery modes.

## The pattern: a native embedded peer

The adapter embeds a Cotal endpoint in the framework's own process — not a separate
bridge. The shared piece is `MeshAgent` (in `@cotal-ai/connector-core`, the same runtime
behind the Claude Code and Codex connectors): it owns the NATS connection, presence, and a
stream-backed inbox, and emits `"incoming"` for each message. The adapter wires two things
around it:

1. **Inbound drives the loop.** The peer drives straight off the inbox via an `InboxTurn` —
   the inbox is the single source of truth, no parallel buffer. On `"incoming"` it surfaces
   the front message, flips presence to `working`, runs the agent, and delivers the reply on
   the same delivery mode (DM/anycast → DM the sender by id; channel → multicast back to that
   channel), then flips to `idle`. Delivery is **ack-on-surface**: the surfaced run is
   `drainInbox`-acked only once the turn completes, so a crash or restart redelivers and
   nothing is lost. The loop owns delivery (always routed right, sent once); runs are
   serialized; the peer answers DMs and anycasts but only replies on a channel when named
   (never its own echoes — ambient chatter is ack-dropped).
2. **Mesh awareness as tools.** The model also gets read/presence tools via the framework's
   tool mechanism (`defineTool()` for pi): `cotal_roster` (who's present) and `cotal_status`
   (set its own status). Sending is left to the loop, so the model can't mis-route or
   duplicate a reply.

This makes the agent a real peer that wakes on traffic, like Claude Code — not a pull-only
tool caller.

**pi** is a clean fit, since it ships as an embeddable library: `@cotal-ai/pi` embeds
`MeshAgent` alongside a pi `createAgentSession()` in one process, reads presence straight off
the session's own event stream (`agent_start` → `working`, `tool_execution_start` → the
running tool, `agent_end` → `idle`), and drives the loop with the session's own verbs —
`prompt()` to wake an idle session into a turn and `steer()` to fold a *same-scope* message
into a *live* one (true mid-turn drive, before the next LLM call; a different-scope message
waits for its own turn, so a private DM is never folded into a channel reply), with `abort()`
to interrupt. No external
channel, host process, or keystrokes — inbound `"incoming"` calls a method on the embedded
session. pi has no built-in permission gate, but in TUI mode (`PI_PEER_MODE=tui`, or the
agent file's `peerMode: tui` frontmatter hint) any pi extension that calls `ctx.ui.*`
(approval gates, prompts, selects, editors) is rendered live in the peer's tmux pane and
becomes operator-answerable per-pane (e.g. an edit-approval gate); headless peers
(unset/`headless`) run unattended (sandbox/containerize per pi's own guidance). It needs
Node ≥22.19 and a provider key in the env.

A `Connector` extension (`buildLaunch`) lets the manager spawn it: it launches the peer via
`tsx` (dev) or `node` (built `dist/`) and forwards the launcher's identity (`COTAL_ID`), minted
creds (`COTAL_CREDS`), and the agent file (`COTAL_AGENT_FILE`). At launch it parses the agent
file and forwards the resolved model (`COTAL_MODEL` — the `cotal start --model` flag takes
precedence over the file's `model:`); each runtime path reads the file's persona body and
injects it as the agent's system prompt, so a spawned peer runs as its declared persona.
Under auth the peer authenticates as the id the manager provisioned. The connector
self-registers on import (`pi`); a composition root just imports it.

## Running

The pi connector has an example composition root under `examples/03-pi` (a manager that
imports `@cotal-ai/pi`). See its README to run it; in short:

```bash
export ANTHROPIC_API_KEY=sk-...
pnpm cotal up
pnpm --filter @cotal-ai/example-03-pi manager
pnpm cotal start --name pi1 --role research --agent pi
```
