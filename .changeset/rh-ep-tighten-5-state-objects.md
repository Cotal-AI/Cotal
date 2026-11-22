---
"@cotal-ai/core": patch
---

Internal refactor: the endpoint's start/stop/rebuild state, its presented credential and renewal state, and its channel-registry cache each live in one state object (`LifecycleState`, `CredentialState`, `ChannelRegistryState`) that the endpoint's internal parts share by reference, replacing per-field getter and setter callbacks. No behaviour change.
