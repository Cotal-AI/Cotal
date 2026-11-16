---
"@cotal-ai/cli": patch
---

Report a self-update refused before any change as a refusal instead of an unknown outcome.

The initial execution check preserves its reason and owning install command, states that no changes were made, and exits with the boundary-refusal code. Failures after update work begins keep their existing outcome handling.
