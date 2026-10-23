---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

After `space forget` on a stopped controller stack, `status` and every command in that root now say
to prepare the space again with `cotal space create <space> --root <root>` before `cotal up`. Before,
they said to run `cotal up`, which refuses there until the space is prepared again.
