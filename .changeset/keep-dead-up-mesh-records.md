---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Keep a dead `cotal up` mesh record as offline, with its root in the error

A liveness miss used to delete every registry record that was not `origin: "manual"`, including
`origin: "up"` and pre-origin records. `cotal meshes` was the command the error pointed at, and it
was the command that destroyed the restart authority. The record was already written at provision
time; this change stops withholding survival from it.

`pruneMesh` is now reason-gated. `gone` (the liveness sweep, and preflight `unreachable`) keeps
every origin as `offline`. `mismatch` (credentials rejected, open-now-auth, stale-auth-root) still
drops an `up` record and still never drops a `manual` one. `cotal down` / `cotal clean all` still
drop `up` records for the root they tear down.

The unreachable copy for a kept `up` record still starts `no mesh running at <server>` and then
names the recorded root, telling the operator to run `cotal up` there, so a bare `cotal up` in
the wrong cwd cannot start a different mesh.

A liveness sweep still returns `{ pruned, offline }`. Resolution now uses `offline`: a record
known dead is not a live candidate for a bare command (`no mesh running` / `multiple meshes
running` name only meshes that answered). `--space` still resolves a dead record so preflight
can name its root. All-offline is still `no-meshes`; the named-space path is what reports
"recorded but not running".
