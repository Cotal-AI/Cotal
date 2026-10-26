---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The bare `cotal down` that refuses `LIFECYCLE_BLOCKED` while another registered space names this
stack's exact broker address now names what to run: `cotal space show <space>` for each of those
spaces, the `cotal space forget <space>` that takes one off this address, and the `cotal down` to run
again. Its next step used to name no command, so the running stack had no documented stop.
