---
"@cotal-ai/cli": patch
---

Stop the control-target mode peek from exiting on an off-registry target. `--server` with an unregistered `--space` is the raw-open escape hatch and has no registry entry to carry a mode, but the peek resolved through the exiting form and ended the command before `connectOrExit` could serve it.
