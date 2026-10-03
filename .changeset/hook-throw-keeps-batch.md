---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

A Claude Code hook that throws after it has started to surface peer messages no longer acks them. The empty reply it returns carries nothing, so the batch stays un-acked and reaches the model on a later frame. The seat also drops `turn-pending` rows that break the manager contract, such as one with no integer deadline, which used to make every hook frame throw. A `turn-pending` reply with no `turns` array leaves the seat's known turns in place.
