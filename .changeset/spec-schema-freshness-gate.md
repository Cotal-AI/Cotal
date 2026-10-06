---
"@cotal-ai/connector-core": patch
---

The committed message schema is current with the core types again: the data part's `data` now references a `JsonValue` definition, as `Part` has declared since data values were restricted to JSON. Validation verdicts on parsed JSON are unchanged. `pnpm check:docsbundle`, which CI runs, now regenerates the schema and fails when the committed file differs, so a wire-type change cannot leave it behind again. The `cotal_docs` schema page carries the regenerated file.
