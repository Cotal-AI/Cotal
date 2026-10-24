---
"@cotal-ai/cli": patch
---

A service start, restart or install whose executable or working directory was moved, removed or
changed mode since `add` now names that path and what is wrong with it, such as `does not exist` or
its mode, and its Next names the fix: putting it back, `chmod u+x <path>` or `chmod u+rx <path>`,
or `cotal service remove` to add the service again with another path. It used to say only that the
executable or working directory was not usable, with no path and no Next.
