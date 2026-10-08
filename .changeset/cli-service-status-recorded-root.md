---
"@cotal-ai/cli": patch
---

`cotal service status` now refuses a service unit or launchd agent that records its mesh but no absolute root, with the uninstall-and-reinstall remedy. Before, `--json` reported a unit with no root as installed with no root and no manager record, the human output crashed with `Cannot read properties of undefined (reading 'state')`, and a recorded root that was not an absolute path read the manager pidfile relative to the current directory. An installed status now always carries its unit, root and manager record.
