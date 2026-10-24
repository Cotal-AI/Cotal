---
"@cotal-ai/cli": patch
---

A mesh registry record that does not parse now refuses every command that reads the registry with `SCHEMA_INVALID`, exit 1, naming the file, as `space` and `space show` already did. `use`, `space forget`, `space create`, `send`, `persona` and the other commands that reach the registry used to end with "Outcome unconfirmed" and `OPERATION_UNKNOWN`, exit 3, which said the command might have had effects it did not have.
