---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The manager logged nothing when a seat left its ownership, on any path. A live
supervisor lost several seats while it kept running, and because its log carried
no per-seat exit line, "the supervisor reaped them" and "they died on their own"
were indistinguishable afterwards — the incident could not be attributed from
supervisor state at all.

Every free path now emits one line at `freeSlot`, the single chokepoint they all
pass through, naming the seat, its lifecycle uid, which path gave up the slot,
and what the runtime saw when the child ended. The cause is a required argument
with no default, so a new free path cannot compile without naming itself.

`AgentHandle` gains an optional `exitInfo()`; the pty runtime stops discarding
the exit code and signal node-pty already hands it. Absent means UNKNOWN and
prints as unavailable naming the runtime — a backend that attaches to an
externally-owned process (tmux/cmux/orca/herdr) cannot see how the child ended,
and a default of `code 0` there would fabricate a clean exit on precisely the
seats whose death nobody can explain.
