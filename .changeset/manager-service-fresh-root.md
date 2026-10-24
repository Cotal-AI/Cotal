---
"@cotal-ai/manager": patch
---

`cotal service start` of a `manager` preset whose root `space add --root` registered, and where no
command has written yet, no longer fails with a raw `ENOENT` stack in the service log. The launch
makes the root's `.cotal` as a directory private to you, after its other checks pass and only once
the root is protected. A `.cotal` already there, such as a link, is not replaced.
