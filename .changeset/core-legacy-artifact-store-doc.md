---
"@cotal-ai/core": patch
---

The doc comment on the legacy artifact-store size constant no longer opens with a stale sentence calling it the store's `max_bytes` cap. An unclosed opener had merged that sentence into the real comment, which says the store is created uncapped and the 4 GiB value is only recognized to migrate legacy stores. No behavior changes.
