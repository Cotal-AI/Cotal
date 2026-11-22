---
"@cotal-ai/cli": patch
---

`ps` without a terminal now points at `setup --help` instead of bare `setup`, as `status` already does. On a terminal the bare `setup` suggestion is unchanged.
