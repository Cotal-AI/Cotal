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

Codex 0.146 does not persist an empty `thread/start` soon enough for a remote TUI to resume it.
The connector therefore starts one explicit orientation-only bootstrap turn (or the operator's
`--prompt` when supplied), waits until `thread/read` reports the exact rollout path and that file
exists, and only then attaches the TUI. The default bootstrap calls `cotal_orientation`, requests
no file changes or unrelated work, and leaves the peer available for messages; no timing sleep is
used as a readiness signal.

## Delivery behavior

An idle peer message uses `turn/start`. While a turn is active, matching-scope traffic uses
`turn/steer` with the active turn id. DMs from different senders and messages from different
channels queue into separate turns, preventing private and channel audiences from being
blended.

The durable boundary is turn completion:

| App-server outcome | Inbox result |
|---|---|
| `completed` | acknowledge the exact ids surfaced into that turn |
| `failed` / `interrupted` with mesh work | leave unacknowledged and start one in-process reconciliation turn |
| `failed` / `interrupted` without mesh work | no inbox effect; keep the connector alive |
| uncertain steer | reserve that exact batch; reconcile it after the active turn reaches a terminal event |
| uncertain `turn/start` with no terminal event | hold the exact batch in-process without retrying |
| steer rejection / completion race | keep queued; start a new turn only after the active turn is known complete |
| app-server transport or host process dies | stop non-zero; no cross-process recovery guarantee |

The reconciliation turn keeps the same app-server thread and Cotal endpoint lifecycle. Its prompt
names the reserved inbox ids, repeats only that exact batch, and tells Codex to inspect current
state before doing only missing work; newer DMs and channels stay queued for later scope-separated
turns. Only a clean reconciliation completion acknowledges the original ids. The connector does
not replay MCP calls itself. If reconciliation also fails or is interrupted, the batch remains
held and the endpoint stays alive rather than entering an automatic retry loop.

This is the safe boundary available today, not process-resume durability. Ordinary foreground and
manager teardown retire the lifecycle-keyed consumers and credentials. A replacement
`cotal spawn`, even with the same display name, receives a new endpoint lifecycle and is not
guaranteed to receive the old batch. If app-server transport, the host, or the attached TUI dies,
the connector exits non-zero and currently cannot preserve that identity across process restart;
unacknowledged work may therefore be orphaned. Do not use relaunch as recovery.

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
Cross-process preservation of the Cotal lifecycle and a second operator-triggered retry for a
held reconciliation batch are also not implemented.

Implementation details and the comparison with the earlier PR #254 approach live in the
[package README](../extensions/connector-codex/README.md).
