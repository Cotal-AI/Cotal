---
"@cotal-ai/core": patch
---

Add explicit opt-in native full account resolution to the broker configuration renderer, preserving the default memory configuration. Full mode uses bounded host-selected settings, disables deletion and retains signed account updates across restart. It does not provide signing, update serialization or lifecycle retirement.
