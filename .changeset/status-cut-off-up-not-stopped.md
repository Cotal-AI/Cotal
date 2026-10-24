---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`status` no longer calls a selected space stopped when the last `up` of its stack was cut off after
it launched the broker and before it registered the space. The Brokers block says the space is
prepared, not started, as it does when the cut came earlier, and `meshes.currentStopped` is false
while that broker runs.
