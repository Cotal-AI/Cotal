# @cotal-ai/connector-codex

The Codex edge adapter for Cotal. It keeps one Codex 0.146.0 app-server alive, opens one
thread, and attaches the real Codex TUI to that thread. A peer message starts an idle turn
or uses `turn/steer` with the active `expectedTurnId`; the process is not respawned per turn.

The package embeds `@cotal-ai/connector-core` for mesh identity, inbox delivery, presence,
and the shared `cotal_*` tools. It serves those tools from the same `MeshAgent` over an
authenticated loopback MCP endpoint injected into this thread only, so Codex can reply
with `cotal_dm`, `cotal_send`, or `cotal_anycast` without a second mesh endpoint or global
config change. Nothing Codex-specific enters `@cotal-ai/core`.

## Delivery and lifecycle contract

- Inbox entries stay unacknowledged through `turn/start` / `turn/steer`. Only a matching
  `turn/completed` with `status: "completed"` acknowledges the exact surfaced ids.
- Failed, interrupted, timed-out, and connection-lost turns leave their ids queued and stop
  this host non-zero. The manager records the exit as a failed agent; it does not automatically
  restart it. A later launch with the same identity receives the durable redelivery, while the
  uncertain process never guesses that replay is safe.
- A steering rejection leaves the batch queued. If completion already won the race, it
  becomes a new turn; otherwise it waits for the authoritative completion event.
- DMs are scoped by sender and channel messages by channel. Different audiences never share
  one connector-driven turn.
- The connector never retries MCP tool calls. A distinct repeated model tool call is a new
  side effect; Cotal message ids provide downstream message deduplication, while the
  connector does not pretend an uncertain external action is safe to replay.
- Presence comes from `turn/*`, `thread/status/changed`, approval requests, and
  `serverRequest/resolved`; terminal pixels are never scraped.
- Shutdown interrupts the active turn, leaves interrupted work unacknowledged, cleans that
  thread's background terminals, and reaps only the app-server, TUI, MCP/control servers, and
  socket directory created by this launch.

Codex reads the user's existing login and config through the normal HOME/XDG paths. The
connector strips `OPENAI_API_KEY` and all mesh/control credentials from Codex child
environments. The loopback MCP bearer is passed only in this thread's in-memory MCP config,
not in the shell environment. It does not mutate global config, force
approval policy `never`, or disable the sandbox. Explicit `--opt` values become per-thread
app-server config only. The bridge never answers approval or elicitation requests; Codex
0.146.0 fans them out to the attached TUI, which remains the human decision surface.

Current limits fail loudly: Windows, resume/fork, transcript mirroring, and
`connectors.codex.mcpServers` sharing are not implemented. Cotal's managed MCP endpoint is
merged with other per-thread MCP configuration under the reserved `cotal` name.

## Relation to PR #254

PR #254 established a useful baseline: one long-lived Cotal `MeshAgent`, a shared Cotal
tool server, persistent Codex thread history, explicit package registration, and a focused
fake-free launch shim. Its `codex exec` design is also simpler than a bidirectional
app-server client.

This implementation is independent and remains based on upstream `main` at v0.14.9. It
does not reuse PR #254's pre-execution `drainInbox()`, fresh `codex exec` process per turn,
mandatory `--dangerously-bypass-approvals-and-sandbox`, or headless-only lifecycle. Those
choices can lose acknowledged work when a turn fails, cannot steer a running turn, do not
preserve a live app-server/TUI runtime, and leave retrying side effects underspecified.
The app-server design costs more lifecycle code, but makes those boundaries observable and
testable.
