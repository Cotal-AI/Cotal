---
"@cotal-ai/manager": patch
---

The manager's user-mode spawn provisioning declares its options and its result once, and the local and hosted enrollment arms both take those declarations. Each arm used to spell out its own inline copy, so a field added or changed on one arm still compiled while the other drifted. Runtime behavior is unchanged.
