---
"@cotal-ai/cli": patch
---

Refuse delivery cutover when the judged manager's record changes or disappears before its pid-bound stop, including an empty replacement or an absent pidfile with leftover artifacts. Preserve a successor's records instead of silently continuing after cleanup that did not stop the judged process.
