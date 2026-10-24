---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
---

`cotal send` on a broker whose JetStream store holds more than its `--max-file-store` cap now refuses `DEPENDENCY_UNAVAILABLE` (exit 2), naming the store and the cap, and says nothing was stored. It used to exit 3 saying the message may have been stored, although the broker had refused it. Its Next is `cotal history clear --yes`, which makes room. `cotal status` shows that store as `full` with the bytes stored and the cap, and leads its Next with the same clear. The endpoint gains `storedBytes()`, the bytes its account holds in JetStream file storage.
