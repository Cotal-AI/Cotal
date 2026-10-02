---
"@cotal-ai/runtime": patch
---

A hosted run that completes now despawns every seat it spawned, including a race winner's and a plain sequential spawn. Before this, only seats on cancelled branches were released, so a long-lived orchestrator accumulated seats until the manager refused further spawns.
