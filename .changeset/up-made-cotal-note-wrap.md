---
"@cotal-ai/cli": patch
---

`cotal up` in a new folder under your home now wraps its stderr note `made <root>/.cotal for this folder's records; the machine's home .cotal was not used` at spaces on a terminal, to the width of stderr. A path wider than the line keeps a line of its own and is never split, and each line stays dimmed. When stderr is not a terminal the note is still one line, even when stdout is a terminal, and exit codes are unchanged.
