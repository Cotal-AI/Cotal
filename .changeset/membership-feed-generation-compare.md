---
"@cotal-ai/core": patch
---

The membership feed now decides "the renewal owner has not re-signed yet" by credential GENERATION
rather than by envelope bytes. The refusal compared two whole creds envelopes with `===`, which tests
transport representation rather than identity: the envelope carries the nkey seed and is sensitive to
formatting, which is exactly why `credsFingerprint` hashes the JWT instead. The rw source is
caller-supplied and opaque — a secret-store adapter, an editor, a filesystem round trip — and any of
them can hand back the same credential in a differently formatted envelope. Compared by bytes that
read looked like a fresh generation, so it was adopted past its own renewal point, the next renewal
tick was floored to one second, and the feed re-read the store every second for the rest of the
credential's life. The 60-second retry never applied, because the fetch had not failed: it succeeded
and returned unusable material.
