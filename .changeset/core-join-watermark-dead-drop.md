---
"@cotal-ai/core": patch
---

The endpoint no longer carries the chat join-watermark drop left over from the removed per-instance chat durable. The consumer pump only drives the DM inbox and the role task queue, so its chat branch, the `dropWatermark` helper and the `joinSeq` map it read could never run. A join still captures the chat frontier to bound its backfill, and the live subscription opened after it carries only later messages. Comments on the role task durable now state its filter as `svc.<role>.>`, and the owner-token validator's doc no longer claims it has no call sites. The SPEC interop scenario no longer describes an ack-drop of live duplicates. No behavior changes.
