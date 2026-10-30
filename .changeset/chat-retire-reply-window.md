---
"@cotal-ai/cli": patch
---

Wait long enough for a static chat session's retirement answer. With the delivery daemon stopped, closing `cotal chat` now reports the retirement pending and names the daemon (exit 4) instead of timing out as an unknown outcome that blamed the manager.
