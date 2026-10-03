---
"@cotal-ai/runtime": patch
---

A hosted run that completes now despawns every seat it spawned, including a race winner's, a plain sequential spawn, and a spawn that failed catchably while its process stayed up. Before this, only seats on cancelled branches were released, so a long-lived orchestrator accumulated seats until the manager refused further spawns. A fork child never releases a seat copied from its parent, and a spawn marked `onFork: "adopt"` is never released at completion, because a fork may still be using it. A seat a migration handed to a later spawn follows that spawn's policy, and in a space with several managers a despawn treats a seat as already gone only when the manager that allocated it says so.
