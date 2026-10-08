---
"@cotal-ai/core": patch
---

`resolveService` now bounds the whole resolve by its `deadlineMs`, contract store reads included. The describe spends from that deadline and each closure walk gets what remains of it, so a slow or stalled store read fails the resolve with `deadline-exceeded` at the caller's deadline. Each walk used to run under its own 30 second budget, so a resolve given 300 ms could take seconds. Cancelling a resolve through its `signal` now settles a store read in flight instead of waiting for it to return, through a new optional `signal` on `fetchContractClosure`. Every caller that resolves an endpoint inherits the bound, including `invokeService`, `cotal describe`, `cotal invoke` and the `cotal status` manager probe. A resolve given no deadline is bounded as a whole by the 10 second default the describe already used.
