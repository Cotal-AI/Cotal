---
"@cotal-ai/cli": patch
---

Bare `cotal status` shows the selected space's delivery responder again. Since the command-line redesign it showed it only in `--verbose`, or on this folder's own delivery process row, so an operator on a manager host away from the broker's folder could not see that spawn, retirement and join were blocked. The selected-space section now has a `Delivery responder` row that reads bound, not bound, or not bound with a dead daemon's record still holding the lease, as the verbose section does. The section now also appears for a broker named with `--server` when nothing on this machine is registered.
