---
"@cotal-ai/pi": patch
---

A pi seat now marks a run turn as shown once the provider takes the request that carries it, instead of after the whole Pi turn ends. A `cotal_yield` made during that turn used to be refused with "no turn is active — nothing to yield", and the run then recorded `done` where the seat had said `blocked` or `handoff`. On a transport that reports the provider response, the unshown turn was also injected again after every response, so the Pi turn never ended and the run turn ran out its deadline. A transport without that report shows the turn when Pi runs a tool from the answer, or at the clean end of the turn.
