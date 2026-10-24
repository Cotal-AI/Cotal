---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Every no-responders answer on the reserved sentinel now reads refused instead of unknown: core marks it `not-executed`, as SPEC 13.3 requires. An unpinned `cotal spawn` that no manager receives is refused with `TARGET_UNAVAILABLE` and exit 2. It names bare `cotal up` when no manager runs, and the `cotal ext add` to run when no live manager has an agent application installed.
