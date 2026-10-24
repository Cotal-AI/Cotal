---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A hung stack manager no longer reads as healthy and no longer leaves the stop commands without a
way out. `status` read a controller stack's manager only from its instance record, which stays
`running · endpoint serving` while the process lives, so a stopped or hung manager showed green.
A running `stack-manager` now gets one probe of its manager endpoint: the selected space's `Manager`
row reads `answering`, `not answering · stack-manager pid <pid>` or `endpoint not checked`, and the
JSON result carries it as `stackManager`. A manager that does not answer puts `kill -KILL <pid>`
first in Next. `down --yes`, `service stop` and `service restart` gave exit 3 with no Next and no
pid when the manager did not answer its describe. They now refuse `LIFECYCLE_BLOCKED` (exit 2),
name the manager's pid and say no stop was submitted, and their Next ends that process so the same
command finds it gone and goes on.
