---
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

The `card-host` and `ep-rail-failure` smokes now wait for their broker to exit before removing its store. Both sent SIGTERM and removed the JetStream store on the next line, so the removal could walk a tree the broker was still writing during its graceful shutdown and fail the shard with `ENOTEMPTY` after every check had passed. Shipped behaviour is unchanged.
