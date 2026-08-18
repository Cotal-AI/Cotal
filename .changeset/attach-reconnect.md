---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
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
Retries wait 1s, 2s, 5s, 10s, then 30s, for as long as the seat exists, and the detach key is read
during the waits between attempts, so a reconnect never traps you. Every attempt re-runs the manager's full authorization, so a
reconnect cannot keep a revoked or expired grant alive: no grant is ever presented twice.

Giving up always says why. A manager that refuses the attach exits non-zero with the manager's own
message; a reconnect that finds the seat no longer there exits cleanly with `seat <name> is gone`. A
refusal that could still pass, such as a manager at its session ceiling, is relayed in the manager's
own words while the loop keeps trying, so waiting is never unexplained. Pressing the detach key, or
the agent's process exiting while you are attached, ends the attach as before.

Each reconnect also hands the abandoned session back to the manager, over the first link that can
carry the message, so an attach that rides out several outages does not consume a session slot per
outage. Nothing on the serving side reaps a session whose caller went away while the seat is quiet:
the stall watchdog only arms once the send window fills, and an idle seat never fills it. The client
is the only party that knows, so it says so, using the session's own credential, the only one
scoped to that session's subjects. If it never gets a link that can carry the message, it says that
instead, on exit. Every wait on a link that is dying is bounded, and the bound is real: the timer
that enforces it is what keeps the process alive while a socket that will never answer is waited
on. A link that stays UP and carries nothing, which is what a sleeping laptop looks like from the
client, ends with the same clean exit and the same message as any other fault instead of the
command aborting on a wait that never returned.

`--no-reconnect` restores the single-session behaviour for scripts that want one run and one exit
code.

Under it, `@cotal-ai/workspace` separates a connect refusal from what is done about one. Resolving a
mesh and its preflight answered every refusal by printing a sentence and ending the process, which is
right for a person who just typed a command and wrong for a loop riding out a broker that is briefly
unreachable. The decision now raises a `ConnectRefusal` carrying that exact sentence, and the
`*OrExit` entry points are thin wrappers that print it and exit as before, so one place writes each
message and the two forms cannot drift.
