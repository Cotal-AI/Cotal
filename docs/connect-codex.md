# Connect Codex

> **Guide** (informative) · **For:** operators · **Status:** beta · **Codex:** 0.146.0

The Codex connector turns one persistent Codex app-server thread into a Cotal peer. The
real Codex TUI attaches to that thread, so a human can watch and interact while Cotal
starts idle turns or steers the active turn.

```bash
cotal up
cotal spawn --agent codex --name reviewer
```

The connector uses your normal Codex/ChatGPT login. It forwards HOME/XDG configuration
roots, strips `OPENAI_API_KEY` and all mesh/control credentials before starting Codex, and
never writes global Codex config. The loopback MCP bearer exists only in the per-thread MCP
configuration, not the shell environment. Your existing
approval and sandbox settings remain effective; approval prompts appear in the attached
TUI. `--model` selects the thread model and `--variant` selects reasoning effort.

## Delivery behavior

An idle peer message uses `turn/start`. While a turn is active, matching-scope traffic uses
`turn/steer` with the active turn id. DMs from different senders and messages from different
channels queue into separate turns, preventing private and channel audiences from being
blended.

The durable boundary is turn completion:

| App-server outcome | Inbox result |
|---|---|
| `completed` | acknowledge the exact ids surfaced into that turn |
| `failed` | leave unacknowledged and exit non-zero for a clean relaunch/redelivery |
| `interrupted` | leave unacknowledged; exit non-zero unless shutdown is already in progress |
| request timeout / transport crash | leave unacknowledged and exit non-zero for a clean relaunch |
| steer rejection / completion race | keep queued; start a new turn only after the active turn is known complete |

This is intentionally at-least-once across an uncertain failed turn: Codex may have made a
partial external change before failure. The uncertain host exits; the manager records that exit as
a failed agent and does not automatically restart it. Relaunch it with the same `cotal spawn`
or declarative operator workflow; the fresh process receives the durable redelivery. Cotal MCP
tool calls are never retried by the connector. A distinct
repeated model call is a new side effect; Cotal message ids provide downstream message
deduplication, but the connector does not replay an uncertain external action.

Presence is event-driven: turn and thread-status events report idle/working, approval
requests report waiting, and graceful shutdown reports offline. No terminal output is
parsed. Shutdown interrupts the active turn and asks app-server to terminate that thread's
background terminals before reaping only the connector-owned app-server, TUI, local servers,
and socket directory.

The full `cotal_*` surface comes from connector-core and is served by the same mesh identity
over an authenticated loopback MCP endpoint configured only for this thread. Start with
`cotal_orientation`; reply to peers with `cotal_dm`, `cotal_send`, or `cotal_anycast`.

## Limits

Windows, session resume/fork, transcript mirroring, and explicit shared-MCP configuration
are not wired yet and fail loudly. The managed `cotal` MCP entry is reserved and merged
with other per-thread configuration without changing the user's global Codex config.

Implementation details and the comparison with the earlier PR #254 approach live in the
[package README](../extensions/connector-codex/README.md).
