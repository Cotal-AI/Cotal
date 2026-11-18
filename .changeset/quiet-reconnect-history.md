---
"@cotal-ai/connector-core": patch
---

Keep channel backlog received after a reconnect from starting new agent turns.

Channel posts with a sender timestamp before the current transport connection are marked historical and kept pull-only, including mentions. DMs and role requests keep their normal delivery behavior, and messages already buffered in the same process retain their classification.
