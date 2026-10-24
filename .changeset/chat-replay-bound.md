---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The CLI docs and the `cotal channel show` card now state the bound on a chat session's replay. A
session holds at most 500 unread messages in its inbox, so a channel that holds more replays only
its newest 500. The card said only `Window: retained history`, and the docs named no bound. The card
adds a `Chat replay` row when replay is on, taken from the same constant the session uses.
