---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/runtime": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

The manager hosts workflow runs. `run-start`, `run-resume`, `run-answer`, `run-status` and
`run-ps` are served on the manager's endpoint rails; a run is validated before anything is
recorded, driven in the manager's process under a per-run `run-driver` credential, and taken back
from its journal after a manager restart. `cotal run` is a client of that surface by default,
with `--local` keeping the in-process drive, now under the run's own `run-driver` and
`run-operator` credentials rather than `admin`. A new `run` capability mints the family into an
agent's credential and injects the `cotal_run` tool, so an agent can write a cotal-lang program
and start it from a session. `run-answer` records the answerer from the caller's credential and
takes no `by`; `cotal run answer` drops `--by` on the hosted path. `spawn({ supervise })` is a restart policy the manager enforces in
place: `{ restarts, window? }` (default `10m`) until the budget is spent, then the seat is
retired and the next `turn` is L4002. A policy this host cannot honour is refused at accept.
