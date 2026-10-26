---
"@cotal-ai/auth": patch
---

Add `cotal auth-service --callout-only`, a callout replica: one more member of the space's auth callout queue group that keeps connects answered while the full auth service restarts or crashes, and adds capacity. A replica runs the same connect checks as the full service, which now builds them from the same shared hooks, and holds nothing else: no HTTP listener, no `auth-service.json`, no plane claim, registration, barrier, scanner or sweep. Its store connection reads the auth, records and sessions stores and creates each connect's issuance row, and nothing more. It refuses the HTTP flags and `--service-endpoints`, and exits non-zero when it loses a store connection or the broker. `pnpm smoke:callout-replica` runs the full service and replicas as separate processes under load and counts the callouts each one answers.
