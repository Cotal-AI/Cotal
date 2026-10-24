---
"@cotal-ai/cli": patch
---

`cotal status` no longer reports a controller stack's delivery member as `NOT BOUND` with `cotal up` as the remedy while its process runs without a delivery lease, as when it hangs. The delivery responder line names the member's pid as alive with no lease, so it is starting or not responding, and Next names `cotal service status stack-delivery`, then `cotal down --yes` and `cotal up`. `status` cannot probe the delivery daemon directly yet, so it does not tell those two apart, and a hung daemon still reads as bound until its 30-second lease expires.
