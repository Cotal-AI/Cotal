---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal auth mint <name>` now names a persona file of that name that it cannot use. A file that
cannot be read as a persona, such as one with a YAML error or saved as UTF-16, refuses
`SCHEMA_INVALID` with its path and `cotal persona show <name>`, which says what is wrong. A role
from the file that is not one word of letters, digits, `_` and `-` refuses with its path and
`cotal persona edit <name>`. Neither prints the file's values. Before, both gave a generic refusal
that named no file and no step.
