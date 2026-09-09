---
"cotal-ai": patch
---

Reject dmHistory / channelHistory / multiChannelHistory rows whose payload `from.id` disagrees with the forge-locked subject sender (SPEC §5). History drain types through `isCotalMessage` (the same structural guard Plane-3 already uses) instead of asserting `CotalMessage`, so non-conformant stored JSON is rejected rather than cast. Fail closed on non-object payloads so one poisoned row cannot throw the whole page. Surviving DMs still take recipient from the subject. Trustworthiness here is `from.id` versus the subject sender; payload `from.name` / `from.role` remain advisory.
