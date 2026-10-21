---
"@cotal-ai/cli": patch
---

The detached manager opens its log, which carries the console URL, through `openPrivateAppend`. A symlink planted at the log name is refused instead of receiving the URL and having its target set to 0600 by path. An earlier version's log the user owns is still set to 0600, now through the open descriptor.
