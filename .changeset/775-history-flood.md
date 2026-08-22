---
"@cotal-ai/connector-core": minor
---

Historical channel ambient is now buffered pull-only: a join backfill is delivered as recallable context instead of automatic turns, so a seat joining a long-lived mesh no longer receives the channel backlog as a storm of instructions. Historical @mentions and DMs keep automatic delivery, and live ambient is unchanged.
