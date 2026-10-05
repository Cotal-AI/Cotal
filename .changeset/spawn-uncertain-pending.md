---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

`cotal_spawn` now returns an uncertain launch as a pending result instead of a tool error. A worker that has not joined the mesh within its readiness window is still managed and may yet join, so the result names the allocated agent, its id and its manager, and says to watch the roster, because spawning again starts a second agent. A launch that exits stays an error. The goal follower keeps the acceptance as the reply data of any terminal other than `succeeded`, and `ControlReply` carries the endpoint error code, so the tool keys on the `uncertain` code rather than on the message. A pinned-model spawn that settles uncertain reports its recorded pin the same way.
