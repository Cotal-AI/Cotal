---
"@cotal-ai/runtime": patch
---

A manager-hosted or `--local` run's `wait(down(agent), { timeout })` and `wait(replied(agent), { timeout })` now wait, and resolve `null` when the timeout passes. They used to fail with L4000 before waiting: both armed their timeout without recording it on the step, and the run refuses to mint a wait timer the step did not record. `wait` now records the timers for every event before it branches to the agent-addressed waits.
