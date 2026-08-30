---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/auth": minor
"cotal-ai": minor
---

Make the runtime pid/log namespace per-space. The manager and delivery daemon now record themselves
as `.cotal/manager.<spaceKey>.pid`, `.cotal/manager.<spaceKey>.log`,
`.cotal/manager.<spaceKey>.delivery-aware`, `.cotal/delivery.<spaceKey>.pid` and
`.cotal/delivery.<spaceKey>.log`, through the same `{space}` expansion `auth-service.<spaceKey>.pid`
already used. The five names were root-scoped constants, so one workspace root hosted one manager and
one delivery daemon by filename: a second space booting in the same root overwrote the first space's
record, and every reader of that file then answered about the wrong process. `status`, `down`, `up`,
`clean` and `spawn -f` take the space they are answering about.

Existing single-space meshes keep working across the upgrade. Reads admit a pre-segmentation
root-scoped record while it is the only spelling present, byte-exact, so a `cotal down` still finds
and stops a daemon started by the previous build instead of orphaning it. Writes are always the
canonical space-keyed name, and each start reclaims a provably dead pre-upgrade record first, so an
ordinary upgrade does not leave both spellings behind. A live pre-upgrade daemon is refused rather
than overwritten, and both spellings present is reported as ambiguous rather than guessed.

A folder-wide command reads its space off the runtime records the folder holds. `resolveRuntimeSpace`
decodes the space out of the record filenames and prefers a space whose record is running over dead
residue; two spaces running under one root throws and names both. The previous read came from the
`.cotal/auth` account records, which an open mesh (`broker: { auth: false }`) never writes, so a bare
`cotal down` in such a folder answered with the default space and walked past its own manager once the
records became space-keyed.

`MANAGER_PIDFILE` and `MANAGER_DELIVERY_AWARE_MARKER` move from `pid.ts` to `local-process.ts` and
are now `{space}` templates; both are still exported from the package index. `RESERVED_COTAL_CHILDREN`
no longer lists the five root-scoped runtime names.
