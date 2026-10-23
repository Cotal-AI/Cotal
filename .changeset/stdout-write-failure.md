---
"@cotal-ai/cli": patch
---

A command whose output cannot be written no longer crashes with a Node stack trace. `cotal version >/dev/full` printed a 21-line trace and exited 1, and every command did the same on a failed stdout write. It now prints one line, `could not write to stdout`, with the reason, and exits 3, or with the non-zero status it had already set. A `--json` refusal whose envelope cannot be written keeps its own exit code, and a reader that closes the output early, as `| head` does, stays quiet there too.
