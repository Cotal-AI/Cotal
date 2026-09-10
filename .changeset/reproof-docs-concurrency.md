---
---

Give the Mutation reproof and Docs workflows the same concurrency policy as CI: a new push to a pull
request supersedes the run already going for it, a merge to main queues instead of evicting. Without
a group every pushed head kept its own 12-shard reproof matrix queued against the org's 20-job cap.
