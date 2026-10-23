---
"@cotal-ai/cli": patch
---

`cotal space` and `cotal space show` refuse a mesh registry record that does not parse, or is not a usable record, with `SCHEMA_INVALID` and exit 1, naming the file, as `who` and `whoami` already did. They exited 3 with `OPERATION_UNKNOWN`, which says the command may have had an effect, although both only read the registry.
