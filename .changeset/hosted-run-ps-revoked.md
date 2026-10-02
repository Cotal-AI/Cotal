---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

The hosted `cotal run ps` now reads each run's revocation marker, as `run ps --local` already did. A revoked run whose driver died is listed as `revoked` with the revoker and reason instead of `running`, and a marker the manager cannot read prints `unchecked` and exits 1. The `run-ps` rows gain optional `revoked` and `revocationUnreadable` fields; the record's own `state` is unchanged.
