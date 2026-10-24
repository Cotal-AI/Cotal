---
"@cotal-ai/cli": patch
---

`space create`, `space add` and `meshes add` refuse a space name that starts with `-` with `USAGE_INVALID`, exit 1, before anything is written. Such a name cannot be passed as a flag value, so `use`, `--space` and the stack's own delivery child could not take it. The docs state the name rule: ASCII letters, digits, underscores or hyphens, starting with a letter, digit or underscore.
