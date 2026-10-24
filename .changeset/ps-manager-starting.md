---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal ps` while an `up` is still starting the stack's manager now refuses `TARGET_UNAVAILABLE` saying the manager is starting, with a Next to run `cotal ps` again once `up` reports it started. It used to say no manager was running and point at bare `cotal up`, or fail with the raw "has no live registered instances" error once the manager process ran but had not registered. It reads the stack journal's unsettled `up` and checks that a live process holds the root's maintenance lock, so an `up` that died keeps the no-manager refusal. `@cotal-ai/workspace` adds `maintenanceLockHolder`.
