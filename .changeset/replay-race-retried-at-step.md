---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

Replay a drive's own journal again when a read loses a round, instead of failing the step

A drive reads its journal through one replay durable named after its takeover, before every effect
and at every poll of a parked pause. When another reader held that durable, the read raised
`RunJournalReplayRaced` and the interpreter recorded it on the step as `L4000 handler-fault`, so one
branch of a `parallel` failed on a healthy run. `activateRun` already treats the same error as a
lost round and replays again.

The reads behind a drive's steps (`RunScopeAuthority`, hosted and under `cotal run --local`) and the driver's diagnostic for a
journal with no run record now do the same, with the takeover's bound: up to three replays, one
straight after another, and the race is raised unchanged when the third is lost too. An operator
read runs under a takeover id minted for that one read (the manager and `cotal run` mint a fresh one
per call), so `RunHost.status`, `RunHost.locate` and `cotal run journal` still report the race on
their first read.

Only the race is retried. A reader in another process can also tear a fetch or return an empty
replay; neither is retried here.

A new suite, `smoke:runtime-run-host-replay`, drives the manager's run host through a `parallel` of
three `ask` steps answered within the same second: once while `RunHost.status` reads the drive's
own takeover id, and once while another connection takes records off the drive's durable. No branch
fails in either.

The `connector-core` docs bundle is regenerated for the updated paragraph in `docs/workflows.md`.
