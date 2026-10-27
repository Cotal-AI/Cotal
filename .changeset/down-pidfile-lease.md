---
"@cotal-ai/cli": patch
---

Bare `cotal down` refuses while a manager or delivery daemon has no pidfile and is still renewing its lease, instead of stopping the broker under it or reporting that nothing is running.
