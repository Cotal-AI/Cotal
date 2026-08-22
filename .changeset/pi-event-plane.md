---
"@cotal-ai/pi": minor
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

Pi seats publish an opt-in AG-UI event plane

A Pi seat launched with `cotal spawn --events --agent pi` now publishes its turn boundaries,
assistant text, tool calls and results on `events.<owner>.<actor>`. Event frames carry their
writer epoch and sequence, with message and tool-call identifiers for external readers.

The Pi session JSONL is the durable event source, and the connector writes through the shared
AG-UI holder and write-ahead log. An unarmed Pi session emits nothing. Migration: none.
