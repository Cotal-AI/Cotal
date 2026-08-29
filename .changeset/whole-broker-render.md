---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Render the broker config from the validated tenant inventory, so `cotal up` on a root that holds several spaces keeps every sibling account trusted instead of silently evicting it, and refuses to render while any account record is unreadable.
