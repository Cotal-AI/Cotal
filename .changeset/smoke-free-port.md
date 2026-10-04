---
---

Smoke suites take their ports from one shared `freePort` in `@cotal-ai/smoke-kit`, which never hands the same port out twice in a process. A suite that asked for several ports could be given one of them twice, so an address it treated as dead could become its own broker's. `activity-read-cost` also asks the OS for the four ports it used to derive by adding to another port.
