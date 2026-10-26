---
"@cotal-ai/cli": patch
---

Refuse delivery cutover when the judged manager's record changes or disappears before its pid-bound stop. Preserve a successor's records instead of silently continuing after a stop that did not run.
