---
"@cotal-ai/cli": patch
---

`persona create <name> --file <path>` with a file that names another persona now says which name the
file has and points to `cotal persona create <file's name> --file <path>`. Before, it said only that the
name must match the catalog name.
