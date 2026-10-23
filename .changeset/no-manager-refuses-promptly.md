---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
---

With the space's manager stopped, `cotal run` and its hosted verbs and `cotal models` refuse at once, as `cotal ps` does: `TARGET_UNAVAILABLE` (exit 2) with the Mesh header, the registry's own answer as the native detail, and bare `cotal up` as the next step. They used to wait about 10 seconds for a manager answer that could not come and then print a refusal about the `ep.v1` rail with no code or next step. An unpinned operator call reads the service registry first and refuses only when it lists no live manager; an unreadable registry, a pinned call and a user's manager view go to the manager as before. Core marks the registry's empty answer with a new `ai.cotal.ep.no-live-instances` detail, so a caller can tell it from an unreadable registry.
