---
"@cotal-ai/cli": patch
---

`cotal down delivery`, and a bare `cotal down`, now remove the delivery daemon's per-space credential at `.cotal/space.<key>/delivery.creds` once the daemon is confirmed stopped. `down` used to remove only the flat pre-segmentation `.cotal/delivery.creds`, which a current `cotal up` never writes, so the standing credential of a stopped daemon stayed on disk. `down` now stops the daemon through the same stop as the foreground `up` teardown, which drops both spellings through the secret store.
