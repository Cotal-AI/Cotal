---
---

`mutation-proof` records each mutation before it writes it, so a run that is killed leaves a named state instead of a silently sabotaged file. A later run in the same tree refuses and points at the run that was killed, with the mutation, the config and the backup, rather than reporting the tree as dirty work the operator left. `--restore-live` puts the file back byte for byte with its original timestamp, and refuses instead of guessing when the backup is missing or does not hash to what was recorded. A restore that does not verify now keeps its backup rather than deleting the file the failure message names.

Refs #1607
