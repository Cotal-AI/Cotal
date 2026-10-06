---
"@cotal-ai/connector-jcode": patch
---

A jcode seat now marks a run turn as shown once the Harness accepts the message that carries it, instead of after the whole host turn ends. A `cotal_yield` made during that turn used to be refused with "no turn is active — nothing to yield", and the run then recorded `done` where the seat had said `blocked` or `handoff`. A send the Harness never acknowledges, or one whose acknowledgement cannot be attributed to it, leaves the run turn unshown so the next turn carries it again. A peer message queued behind such a send now waits for that turn to end instead of being written into the session and delivered a second time later.
