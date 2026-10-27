---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/delivery": patch
---

`cotal up --recreate-issued-stores <backup-dir>` lets a mesh that ran 0.110.x or earlier start on 0.111.0 and later. Those releases refuse a space's `KV_cotal_issued_<space>` and `KV_cotal_accepted_<space>` created before bounded retention, and the remedy they named, `nats stream backup` and `nats stream rm`, needed authority no stock credential holds. On the broker that start launches, before any issuer of the space runs, the flag backs up each store created before bounded retention into a new private directory in the layout `nats stream backup` writes (0700 directories, 0600 files, readable by `nats stream restore`). It checks every backup against its stream's message count and last sequence, deletes those stores only after every check passes, and the start then creates both again in the current shape. It touches no other stream. It refuses `USAGE_INVALID` for a backup directory that exists or has no parent and with `-f` or `--restore`, `LIFECYCLE_BLOCKED` while the stack runs, and `CONFLICT` when neither store predates bounded retention. It works on static-auth, user-auth and open spaces, legacy and controller-owned stacks alike.

The step is core's `removeIssuedStoresBeforeRetention(nc, { space, backupDir, inboxPrefix })`, on a connection that holds the new one-shot `issued-store-recreate` profile (`mintCreds`, 30 minutes): `STREAM.INFO`, `STREAM.SNAPSHOT` and `STREAM.DELETE` on those two streams, its own inbox, and a one-use response permission per snapshot chunk. An embedder whose spaces `cotal up` does not start runs it per space with the space's issuers stopped. `cotal auth mint` still exposes only agent, observer and admin, and `teardown` keeps its scope.

`cotal up` on such a store now refuses `CONFLICT` (exit 2) instead of reporting `OPERATION_UNKNOWN` (exit 3); the broker it started is stopped again either way. The store check throws `IssuedStoreBeforeRetentionError`, and its remedy, shared by every binder, names the flag. `docs/UPGRADING.md` gains the operator sections for 0.111.0 (with what a rollback can and cannot do) and for the two 0.112.0 changes to multi-space hosts.

The `deliver --spaces` ready line no longer prints an empty list as `0 space(s): ;`; it reads `0 space(s); retrying <s>`.
