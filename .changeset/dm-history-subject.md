---
"cotal-ai": patch
---

Reject dmHistory / channelHistory / multiChannelHistory rows whose payload `from.id` disagrees with the forge-locked subject sender (SPEC §5). Fail closed on non-object payloads so one poisoned row cannot throw the whole page. Surviving DMs still take recipient from the subject.
