---
"@cotal-ai/manager": patch
---

The manager now decides whether a durable static slot row belongs to a sibling manager instance through one shared rule. `inspect`, `slots`, startup reconcile, the boot sweep and the resume orphan check each spelled that rule inline, so a change at one site could make them disagree about which instance owns a row while the boot sweep terminalizes the rows it believes are its own. Behavior is unchanged.
