---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Move the managed launch request from `@cotal-ai/cli` into `@cotal-ai/workspace`, exported as `@cotal-ai/workspace/launch`. `requestManagedLaunch` sends a `ManagedLaunchRequest` as the manager's `start` command, and `readManagedLaunch` reads the joined agent from its reply as a `ManagedLaunchResult`. `cotal spawn --detach` sends the same request and prints the same output as before. `@cotal-ai/cli` never exported these from its package entry, so no public export is removed.
