# Agent frameworks

Besides Claude Code (see [claude-code-integration](claude-code-integration.md)), agents
built with general-purpose SDKs (or an embeddable agent library) can join a Cotal space as
native lateral peers. Three adapters ship today:

| Extension | Framework | Language |
|---|---|---|
| `@cotal-ai/openai-agents` | [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | TypeScript |
| `@cotal-ai/vercel-ai` | [Vercel AI SDK](https://ai-sdk.dev/) | TypeScript |
| `@cotal-ai/pi` | [pi coding agent](https://github.com/earendil-works/pi) | TypeScript |

They join the same mesh and interoperate — an OpenAI-Agents peer, a Vercel peer, and a pi
peer in one space coordinate over the same subjects, presence, and delivery modes.

## The pattern: a native embedded peer

Each adapter embeds a Cotal endpoint in the framework's own process — not a separate
bridge. The shared piece is `MeshAgent` (in `@cotal-ai/connector-core`, the same runtime
behind the Claude Code and Codex connectors): it owns the NATS connection, presence, and a
stream-backed inbox, and emits `"incoming"` for each message. An adapter wires two things
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
   tool mechanism (`tool()` for the two SDKs, `defineTool()` for pi): `cotal_roster` (who's
   present) and `cotal_status` (set its own status). Sending is left to the loop, so the
   model can't mis-route or duplicate a reply.

This makes the agent a real peer that wakes on traffic, like Claude Code — not a pull-only
tool caller.

**pi** is the purest fit, since it ships as an embeddable library: `@cotal-ai/pi` embeds
`MeshAgent` alongside a pi `createAgentSession()` in one process, reads presence straight off
the session's own event stream (`agent_start` → `working`, `tool_execution_start` → the
running tool, `agent_end` → `idle`), and drives the loop with the session's own verbs —
`prompt()` to wake an idle session into a turn and `steer()` to fold a *same-scope* message
into a *live* one (true mid-turn drive, before the next LLM call; a different-scope message
waits for its own turn, so a private DM is never folded into a channel reply), with `abort()`
to interrupt. No external
channel, host process, or keystrokes — inbound `"incoming"` calls a method on the embedded
session. pi has no permission gate, so spawned peers run unattended (sandbox/containerize
per pi's own guidance); it needs Node ≥22.19 and a provider key in the env.

A `Connector` extension (`buildLaunch`) lets the manager spawn each type: it launches the
peer via `tsx` and forwards the launcher's identity (`COTAL_ID`), minted creds
(`COTAL_CREDS`), and any agent file (`COTAL_AGENT_FILE`), so under auth the peer
authenticates as the id the manager provisioned. The connectors self-register on import
(`openai-agents`, `vercel-ai`, `pi`); a composition root just imports the one it wants.

## Running

All three adapters have an example composition root under `examples/03-*` (a manager that
imports the connector). See those READMEs to run one; in short:

```bash
pnpm cotal up
export OPENAI_API_KEY=sk-...
pnpm --filter @cotal-ai/example-03-openai-agents manager
pnpm cotal start --name oa1 --role helper --agent openai-agents
```

Swap `openai-agents` for `vercel-ai` (and the matching example) to run the other. Import
several connectors in a single manager to put different frameworks in the same space. The pi
connector spawns the same way via `examples/03-pi` — a manager that imports `@cotal-ai/pi`
spawns the agent type `pi`:

```bash
export ANTHROPIC_API_KEY=sk-...
pnpm --filter @cotal-ai/example-03-pi manager
pnpm cotal start --name pi1 --role research --agent pi
```
