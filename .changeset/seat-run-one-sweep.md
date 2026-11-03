---
"@cotal-ai/workspace": patch
"@cotal-ai/runtime": patch
---

A `cotal run` from a managed seat with no `--space` now probes the recorded brokers once. Before, the seat resolve swept the registry, and when it did not apply (an open mesh, or a seat whose own space was down) the operator resolve swept it again, so each record that did not answer was probed twice and the two resolves could judge different registry states. `resolveSeatControlTarget` now reads a sweep its caller hands in, and the new `sweepForSeatResolve` takes that sweep once when the seat resolve would.
