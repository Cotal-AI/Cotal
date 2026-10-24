---
"@cotal-ai/cli": patch
---

`cotal up --dry-run` without `-f` now refuses `USAGE_INVALID` and names `-f <cotal.yaml>` before anything starts or is written. It used to start a real stack, consume the folder's prepared space and register it, and its `--json` form refused with a remedy that pointed at that starting command.
