---
"@cotal-ai/cli": patch
---

`cotal up` no longer ends a `! control plane degraded:` line with "start one with: cotal supervise". Refusals it reports end with the next step for their own cause, such as removing an unattributable pidfile by hand or waiting for a crashed daemon's lease to expire, and the fixed remedy printed after them contradicted those steps. The line now gives the refusal as written, followed by its consequence: until the control plane runs, spawn and retirement have no responder. The exit code is unchanged.
