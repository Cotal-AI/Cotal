---
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

`cotal attach` re-establishes its session when the link dies, instead of leaving you with a dead terminal.

An attach left alone while the laptop slept was gone by the time you came back, in one of two ways
depending on how long the link was down. Shorter than the serving side's stall watchdog: the
manager's rail keeps advancing its sequence into a subject nobody is subscribed to, and the session
transport has no retention, so those frames are gone. The moment the client redials and its
subscription is restored, the next frame lands far ahead of what the client expected, the rail
faults, and the CLI exits with `mesh session transport error: gap` about a second after the network
came back. Longer than the stall: the serving rail fills its window, stalls, ends the session and
closes, and both of those notices are published while the client is disconnected, so neither is ever
delivered. On redial the client is subscribed to a session nobody is serving and hangs there with no
output, no honest end and no exit at all.

`attach` now owns re-establishment rather than leaving it to the NATS layer. When the link breaks and
you did not press the detach key, it prints `[cotal: connection lost, reconnecting]` on stderr, then
asks the manager for a fresh grant, mints a fresh per-session credential, opens a fresh connection
and a fresh session, prints `[cotal: reconnected]`, and carries on in the same raw-mode terminal.
The manager repaints the seat's current screen through the path it already uses for any attach.
Retries wait 1s, 2s, 5s, 10s, then 30s, for as long as the seat exists, and the detach key works
throughout, including mid-reconnect. Every attempt re-runs the manager's full authorization, so a
reconnect cannot keep a revoked or expired grant alive: no grant is ever presented twice.

Giving up always says why. A manager that refuses the attach exits non-zero with the manager's own
message; a seat the manager no longer knows exits cleanly with `seat <name> is gone`. Pressing the
detach key, or the agent's process exiting, ends the attach as before.

`--no-reconnect` restores the single-session behaviour for scripts that want one run and one exit
code.
