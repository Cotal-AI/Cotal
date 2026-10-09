---
"@cotal-ai/manager": patch
---

A seat the manager resumes from a preserved cut now meets the manager's `eventsRequired` policy as a fresh spawn does. On a space whose registration requires the event plane, a resumed seat used to launch without that requirement and keep running after its event plane stopped for good, and a seat retained with `--no-events` or on a connector without an event plane resumed with no plane at all. A resumed seat now carries the requirement into its launch material, and one retained without an event plane is refused with the spawn's message before anything is reserved. Spawn and resume take every host-supplied launch field (space, servers, shared MCP servers, env allowlist, resolved harness binaries, `eventsRequired`, workspace root) from one place and ask the same event-plane gate.
