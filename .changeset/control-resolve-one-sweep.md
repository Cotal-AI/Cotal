---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A control command run without `--space` now probes the registered brokers once per resolve. Before this, the control resolver probed every non-catalog record for its mode check, and the connect helper probed them all again before it chose the target; `cotal update`'s manager continuity check added a third round of probes. Each round could wait out the confirming timeout on a record that did not answer, and a broker that started or stopped between rounds could leave the mode check and the connect resolving different targets. `ConnectFlags` now carries the sweep's `offline` set, and `resolveControlTarget`, `resolveTargetOrThrow`, `connectOrThrow`, `connectUserControlOrThrow` and their exiting forms read it instead of sweeping again. A named `--space` still skips the sweep.
