---
"@cotal-ai/cli": patch
---

Connector repair now removes read-only seed leftovers from older releases after an upgrade.
Old unreferenced generations become owner-writable before cleanup, while the current generation
and any generation still referenced by an installed extension stay unchanged.
