---
---

The Mutation reproof workflow now plans its fan-out: one small job runs the selector and names the
shards that hold a selected fixture, and only those shards are fanned. On 2026-09-10, 107 of 228
shard jobs installed and built the tree and then reported no fixtures assigned to them, 173
job-minutes of setup against a 20-job concurrency cap. An empty plan skips the fan-out and the gate
passes only when the plan itself succeeded; a failed plan is unmeasured and fails the gate.
