---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

A space-less `cotal spawn --detach` or `cotal run` from a managed seat's shell now probes the registered brokers once. Before this, the seat resolve swept the registry, and when it did not act as the seat (an open mesh outside the seat's space, a launch without `COTAL_SPACE`, or any non-auth mesh on the `run` path) the operator fallback swept it again, so each record that did not answer was probed twice as often, and a broker that started or stopped between the two sweeps could send the command to the seat's own mesh through the operator path instead of as the seat. Both resolves now read one sweep, and `resolveSeatControlTarget` reads the `offline` set its caller hands in, as `resolveControlTarget` does. A named `--space` still skips the sweep.
