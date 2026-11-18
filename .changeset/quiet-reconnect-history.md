---
"@cotal-ai/connector-core": patch
---

Keep channel backlog received after a reconnect from starting new agent turns.

Newly received durable channel copies more than five minutes old by their sender timestamp are marked historical and kept pull-only, including mentions. Recent copies and live subscription traffic keep their normal wake behavior across short reconnects. DMs and role requests keep their normal delivery behavior, and messages already buffered in the same process retain their classification.
