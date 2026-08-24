---
"@cotal-ai/manager": minor
---

A manager that lost its liveness lease hard-stopped every agent it managed and
deprovisioned each one's credential, durables and broker footprint. Stopping
serving is the right conclusion on that path; destroying the seats is a separate
act, and a broker timeout is not a finding about whether an agent should die.
From the active state the path now detaches: children are left alone, each is
marked retained so no deprovision call site can select it, and the seats are
named on the operator channel.

Two boundaries are unchanged and pinned by cells. Ordinary shutdown (`cotal
down`, Ctrl-C) stays destructive — an operator who asked for a shutdown gets
one. A maintenance cut that has committed and not finalized still stops its
children, because that inventory is owed a replay and a successor replaying it
over live children would spawn a second copy of every seat.

This does not make a child outlive the manager — a pty child dies with the
process that spawned it — it removes the manager's deliberate kill and revoke.
