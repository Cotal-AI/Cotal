---
"@cotal-ai/connector-core": patch
---

Report role requests whose take is still unanswered as held, and avoid waking empty reads while that take is in flight. Late successful takes still wake the reader, and other messages remain readable.
