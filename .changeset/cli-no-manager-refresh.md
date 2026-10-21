---
"@cotal-ai/cli": patch
---

Refuse --no-manager on a controller stack whose manager is still running, before changing its journal or any member. Keep the manager's original identity and state rather than silently returning a no-op that labels it unattempted.
