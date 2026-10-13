---
"@cotal-ai/cli": patch
---

`cotal up --detach` and `cotal up -f` now exit 1 when the control plane does not come up on a first boot. Both printed `! control plane degraded: ...` and then exited 0, so a script or unit read success over a mesh with no manager or delivery daemon, while a refresh over the same failure already exited 1.
