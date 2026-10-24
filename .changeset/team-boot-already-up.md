---
"@cotal-ai/cli": patch
---

`cotal team boot` on a stack that is up says so: the space is already up at this root, no `cotal down`
has stopped it, and nothing was booted. Its Next offers `cotal team deploy <file>` with the same
manifest, which adds its channels and agents to the running stack, or `cotal down` first. It said
only that the last operation was not a completed whole-stack stop.
