---
"@cotal-ai/connector-core": patch
---

The `JsonlFileSource.sealAt` doc comment, which ships in the package's compiled output and its type declarations, no longer carries an all-caps sentence about why the bound is stated or says who reproduced the undetected rewrite. It still states the 512-byte bound and the same-length in-place PII scrub that the seal does not detect. No behavior changes.
