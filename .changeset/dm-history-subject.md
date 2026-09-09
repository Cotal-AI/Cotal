---
"cotal-ai": patch
---

Reject dmHistory / channelHistory / multiChannelHistory rows whose payload `from.id` disagrees with the forge-locked subject sender (SPEC §5). Fail closed on non-object payloads so one poisoned row cannot throw the whole page. Surviving DMs still take recipient from the subject. Trustworthiness here is `from.id` versus the subject sender; payload `from.name` / `from.role` remain advisory. History drain does not require a full CotalMessage shape.
