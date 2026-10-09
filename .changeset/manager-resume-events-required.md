---
"@cotal-ai/manager": patch
---

A seat the manager resumes from a preserved cut now carries the manager's `eventsRequired` into its launch material, as a fresh spawn does. On a space whose registration requires the event plane, the resumed seat used to launch without that requirement and keep running after its event plane stopped for good; it now stops like a freshly spawned seat. Spawn and resume take every host-supplied launch field (space, servers, shared MCP servers, env allowlist, resolved harness binaries, `eventsRequired`, workspace root) from one place.
