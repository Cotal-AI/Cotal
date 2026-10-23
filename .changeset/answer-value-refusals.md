---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run answer` and `cotal run amend` now refuse a `--value` whose record would differ from what was typed, with `SCHEMA_INVALID` and nothing sent. That covers an object that names a key twice (JSON kept only the last), a number outside the range JSON carries such as `1e999` (recorded as null before), and a value nested more than 1000 levels deep. A value nested a few thousand levels deep failed before with a raw "Maximum call stack size exceeded", exit 1, and no `--json` envelope.
