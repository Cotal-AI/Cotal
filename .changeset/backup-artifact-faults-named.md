---
"@cotal-ai/cli": patch
---

`backup verify` now names the file and fault for every artifact it refuses, and `backup restore`
refuses those artifacts instead of reporting an unconfirmed outcome. A snapshot replaced by a
symbolic link, a FIFO or a link to a device, a manifest name with `../` or an absolute path, a
manifest that is a link, larger than its limit or not a JSON object all gave verify one generic
sentence with no file. Restore named some of them but exited 3 `OPERATION_UNKNOWN` although nothing
was attempted. Both now refuse `SCHEMA_INVALID` with `file` and `fault` (`not-regular`,
`invalid-name`, `manifest-not-regular`, `manifest-too-large` or `manifest-invalid`), never print a
declared name that is not a plain file name, and restore leaves the preserved cut unchanged.
