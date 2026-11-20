---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A prepared space record this account cannot read, such as one left owned by root, is no longer reported as a record that does not parse. A command about its space, such as `cotal up` or `cotal use`, refuses `PERMISSION_DENIED`, exit 2, instead of `SCHEMA_INVALID`, and keeps the record. The refusal, the `PREPARED_RECORD_SKIPPED` warning and `cotal status` say the file could not be read and name the step that gives it back, `sudo chown "$(id -un)" <file>` and `chmod 600 <file>`, instead of `cotal space forget`. A record that does not parse or is not a prepared space record still names the forget.
