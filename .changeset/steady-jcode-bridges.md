---
"@cotal-ai/connector-jcode": patch
---

Keep a Jcode mesh seat alive when the first private bridge replacement fails transiently by retrying launch and session attach inside one bounded recovery window, while refusing another launch unless the failed replacement is proven stopped and terminating immediately on permanent SDK refusals.
