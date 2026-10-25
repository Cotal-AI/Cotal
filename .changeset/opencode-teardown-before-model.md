---
"@cotal-ai/connector-opencode": patch
---

The OpenCode 2.x connector no longer acts on a model check that settles after its teardown. A refusal that arrived late used to exit the host process, and a model listed late used to start a mesh agent that was already stopped, which surfaced as an unhandled `cannot start a stopped mesh session`. Both are now ignored once teardown has begun.
