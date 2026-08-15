---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
---

Add the workflow step-journal plane and the run record; separate a refused append from a failed effect.

`WFJ_<space>` is the step journal's stream, deliberately outside the `ep*` plane letters because
the journal is a runtime layer over the control surface rather than part of the endpoint contract.
It captures ONE SUBJECT PER RUN, not one per entry: the mechanism that stops a superseded driver's
in-flight append from landing after its successor has resumed the run is
`Nats-Expected-Last-Subject-Sequence`, which is evaluated per subject, so a subject per entry would
make every append a create at sequence 0 and fence nothing across the run. It carries no age
eviction, because an evicted prefix is not a shorter journal but a run that re-performs effects it
already performed, and no Direct Get, because a resume must read its own predecessor's last appends
and a follower's stale miss reads as "this step never ran". The driver's grants are minted per run —
its own subject, its own replay durable, stream INFO — with no wildcard form, since a `wfj.>`
publish would let one run's driver corrupt another run's journal. The `run` record joins the core
record kinds as the last-value-wins state beside it: the lease holder, the state, the artifact refs
and the pin set, split so a lease renewal does not rewrite the pins.

In the language, a refused durable append is no longer recorded as an effect failure. One `try`
covered both the handler dispatch and the settling append, and the journal mutated its map before
awaiting the append, so a handler that completed plus a store that refused the completion wrote
`[pending, settled:failed]` for work the world had actually done — and every later replay repeated
it. Appends now precede the in-memory move, so a refusal changes nothing, and it travels as
`JournalAppendRejected` (`L5010`) outside the handler's catch.

Three more defects in the concurrency model, all reproduced first. A rejecting `race` arm skipped
sibling cancellation entirely and terminated the run while a sibling kept performing effects; a
failure is a settle, so it now cancels its losers and carries them, and a branch that rejected with
`Cancelled` cannot win the race it lost. `L2032` checked only functions written at the combinator
call, so `parallel({ a, b })` over two named declarations had no branches to check; it now resolves
named branches, follows a branch into the helpers it calls, and refuses at runtime what it cannot
prove statically. And `conclave` — implemented here, having previously parsed and then thrown —
states its membership disposition explicitly instead of leaving it to be inferred from an entry
state that cannot answer it: a close that does not acknowledge leaves the scope unsettled, because
a pending entry is what "a close is still owed" looks like in a journal.
