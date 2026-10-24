---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal status` now follows a controller stack whose last `up` or `down` was cut off before it
recorded an outcome, even when that `up` ended before it registered the space. The selected space
names the blocked or half-started stack, and Next leads with the step that works: the stop to abandon,
the member to inspect, or `cotal down --yes` and then `cotal up --root <root>` when the cut-off `up`
left its broker running. Before, plain status said the space was prepared but not started and offered
`cotal up`, which refused. A command that targets such a space, such as `cotal ps`, says its last
operation has no recorded outcome and names `cotal status` in its root. While the stack is blocked,
the `Delivery responder` row says that `up` refuses until the block is cleared instead of offering
`cotal up`. `status --json` adds `space` and `root` to an unresolved `not-started` selection.
