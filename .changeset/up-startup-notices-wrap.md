---
"@cotal-ai/cli": patch
---

`cotal up` now wraps four more start notes at spaces on a terminal, as other lines do: the note that it selected the space it started, the note that another space stays selected, `wrote default persona` and the note that a new project's space is named after its folder. A path wider than the line keeps a line of its own and is never split, and `cotal use <space>` stays whole. Off a terminal each is still one line on stdout, and exit codes are unchanged.
