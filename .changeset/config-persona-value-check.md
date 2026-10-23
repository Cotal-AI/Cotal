---
"@cotal-ai/cli": patch
---

`cotal config set persona` now refuses a value that can name neither a persona nor a persona file. It saved anything that was not empty, such as `"  spaced  "` or a name holding a terminal escape. A name must use letters, digits, `_` and `-`, as `persona create` requires, and a path must hold no control characters or surrounding spaces. Whether the persona exists is still checked when a launch uses it. The `no harness` refusals of `config set harness` and `setup --harness` now escape the value as the other keys do, so a control character in it no longer reaches the terminal.
