---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Show invisible characters in CLI refusals as Unicode escapes so refused names cannot look like a different name.
The shared operator renderer now covers format and default-ignorable characters, including astral characters, in both quoted errors and report fields.
