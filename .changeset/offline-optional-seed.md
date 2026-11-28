---
"@cotal-ai/cli": patch
---

When the built-in connectors already verify, `cotal update` reports an unfetchable optional extension without reinstalling the built-ins or leaving a failed seed cursor, and `cotal ext remove` can drop the entry after a failed seed if no recovery or installer is pending.
