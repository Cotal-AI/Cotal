---
"@cotal-ai/cli": patch
---

Keep an unacknowledged send's outcome unknown if its stream is later deleted. A later missing-stream observation cannot prove the message was never stored; refusals established before publishing remain unchanged.
