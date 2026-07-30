# @cotal-ai/connector-codex

The Codex edge adapter for Cotal. It keeps one Codex 0.146.0 app-server alive, opens one
thread, and attaches the real Codex TUI to that thread. A peer message starts an idle turn
or uses `turn/steer` with the active `expectedTurnId`; the process is not respawned per turn.

The package embeds `@cotal-ai/connector-core` for mesh identity, inbox delivery, presence,
and the shared `cotal_*` tools. It serves those tools from the same `MeshAgent` over an
authenticated loopback MCP endpoint injected into this thread only, so Codex can reply
with `cotal_dm`, `cotal_send`, or `cotal_anycast` without a second mesh endpoint or global
config change. Nothing Codex-specific enters `@cotal-ai/core`.

On a launch without `--prompt`, the host starts one orientation-only bootstrap turn. Codex 0.146
does not materialize an empty `thread/start` as an attachable rollout, so the host waits for the
exact `thread/read` rollout path to exist before starting `codex resume --remote`. This is a
protocol/file readiness fence, not a blind sleep; the default bootstrap requests no repository
changes or unrelated work.

## Delivery and lifecycle contract

- Inbox entries stay unacknowledged through `turn/start` / `turn/steer`. Only a matching
  `turn/completed` with `status: "completed"` acknowledges the exact surfaced ids.
- A failed or interrupted mesh-bearing turn keeps the same app-server thread and Cotal endpoint
  alive. Its exact reserved batches enter one automatic reconciliation turn with an explicit
  uncertainty prompt: inspect current state, repeat no external action blindly, and finish only
  missing work. New traffic remains queued and scope-separated until that turn completes.
- Only a clean reconciliation completion acknowledges the original ids. If reconciliation itself
  fails or is interrupted, the exact batch stays held in-process without an automatic retry loop.
  Human-only interrupted turns contain no reserved ids and remain harmless.
- An uncertain steer stays attached to the active turn until its terminal event, then reconciles
  without false acknowledgement. An uncertain `turn/start` with no authoritative event is held
  in-process rather than retried.
- A steering rejection leaves the batch queued. If completion already won the race, it
  becomes a new turn; otherwise it waits for the authoritative completion event.
- DMs are scoped by sender and channel messages by channel. Different audiences never share
  one connector-driven turn.
- The connector never retries MCP tool calls. A distinct repeated model tool call is a new
  side effect; Cotal message ids provide downstream message deduplication, while the
  connector's reconciliation prompt requires state inspection before any missing action is
  attempted.
- Presence comes from `turn/*`, `thread/status/changed`, approval requests, and
  `serverRequest/resolved`; terminal pixels are never scraped.
- Shutdown interrupts the active turn, leaves interrupted work unacknowledged, cleans that
  thread's background terminals, and reaps only the app-server, TUI, MCP/control servers, and
  socket directory created by this launch.

Recovery is currently process-local. Ordinary foreground or manager teardown retires the
lifecycle-keyed consumers and credentials; a same-name spawn gets a new endpoint lifecycle and is
not a durable continuation of the old one. If app-server transport, the host, or the attached TUI
dies, the host exits non-zero and unacknowledged work may be orphaned. Cross-process lifecycle
preservation and an operator-triggered second reconciliation attempt are not implemented, so the
package does not claim relaunch redelivery.

Codex reads the user's existing login and config through the normal HOME/XDG paths. The
connector strips `OPENAI_API_KEY` and all mesh/control credentials from Codex child
environments. The loopback MCP bearer is passed only in this thread's in-memory MCP config,
not in the shell environment. It does not mutate global config, force
approval policy `never`, or disable the sandbox. Explicit `--opt` values become per-thread
app-server config only. The bridge never answers approval or elicitation requests; Codex
0.146.0 fans them out to the attached TUI, which remains the human decision surface.

Current limits fail loudly: Windows, resume/fork, transcript mirroring, and
`connectors.codex.mcpServers` sharing are not implemented. Cotal's managed MCP endpoint is
merged with other per-thread MCP configuration under the reserved `cotal` name. Process-local
recovery has the additional limitations described above.

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
