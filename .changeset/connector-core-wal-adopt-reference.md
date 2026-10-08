---
"@cotal-ai/connector-core": patch
---

The event WAL's comment on why a nonzero frontier must carry its source cursor, which ships in the package's compiled output, now names the `DurableSource.read` contract for the rule that reading with no cursor adopts at the current end. It used to cite a line range in `durable-source.ts` that had drifted onto unrelated code, and that file is not in the published package. No behavior changes.
