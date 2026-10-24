---
"@cotal-ai/cli": patch
---

`backup verify` and `backup restore` now name a manifest whose file inventory is not valid. A
manifest that declared a file twice, a file record with an invalid size, SHA-256 or kind, a
checkpoints file over its limit, more or fewer than one checkpoints file, stream records that match
no snapshot, or an invalid space gave verify one generic sentence with no file, and restore exited
3 `OPERATION_UNKNOWN`. Both now refuse `SCHEMA_INVALID` with `file` `manifest.json` and fault
`manifest-invalid`, and a reason that prints no manifest value.
