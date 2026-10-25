---
"@cotal-ai/runtime": patch
---

The plain receipt of `cotal run answer` and `cotal run amend` printed the whole `--value` on one line, so a 100 KB value made a 100,015-character line. It now cuts a value longer than 120 characters, as `run show` does, with a line that says so. `--json` and the stored answer still carry the value whole.
