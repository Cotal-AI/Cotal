---
"@cotal-ai/cli": patch
---

Refuse a direct launch preview when its effective harness is unknown. `spawn --dry-run` now reports `DEPENDENCY_UNAVAILABLE` with exit 2 for an unknown flag, persona pin or preference instead of reporting success with a warning. Managed previews still leave connector validation to the selected manager.
