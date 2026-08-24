---
"@cotal-ai/cli": patch
---

Add `cotal status --components`, a fail-loud per-component health probe that distinguishes an absent process from a live component that is not serving. It reports manager lease/service reachability and explicit unavailable startup phase, delivery ready-lease plus renewal-adoption outcome, web PID-bound HTTP port reachability, and registered broker reachability.
