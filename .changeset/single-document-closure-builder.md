---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

`@cotal-ai/core` exports `singleDocumentClosure(document)`, which returns the §13.7 closure manifest `{ v: 1, root, members: [] }` of one self-contained document and the manifest's closure digest. It builds the manifest with `buildContractClosureManifest`, so every closure manifest core mints follows one rule. The auth and manager service contracts and `VOID_SCHEMA_DIGEST` now build their closures with it instead of each writing the manifest by hand, and the platform host example in `docs/embedding.md` uses it. Every digest they produce is unchanged.
