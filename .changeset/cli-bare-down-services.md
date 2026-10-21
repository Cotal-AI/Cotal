---
"@cotal-ai/cli": patch
---

Bare `cotal down` on a legacy root now stops the space's service instances through the service controller before it stops the stack, where it used to refuse while any service record existed, a stopped saved service included. Each running instance gets the checks and receipt of `cotal service stop <name> --instance <id> --yes`. An instance already stopped is skipped, and saved definitions stay. Every instance is checked before the first stop: an unreadable record, a retained native attempt, an unsettled request, a process that cannot be observed or a record from another host refuses with nothing stopped, and the remedy names the service and the command to run. `cotal down --dry-run` lists what bare `down` would stop, skip or refuse.
