---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Admit seat checkpoints and take custody on the resume path, before anything starts.

An ordinary `up` from a preserved cut now runs the three admission gates over that cut's seat checkpoints, then claims the seat's next writer generation, all before the resume attempt is journalled and long before a manager launches. A refusal at that point costs nothing; the same refusal after a launch would be a second writer.

Integrity checks presence, regular non-symlink, byte size and sha256, and re-stats after the read. Identity checks the space, that the recorded `lifecycleUid` is not live, and the profile revision, with no blanket override. Recency compares `capturedAt` to this host's clock against the horizon the record carries, refusing outside it with all three values named. `--accept-stale-checkpoint` admits a stale checkpoint and prints the consent that was exercised with the actual age; `--accept-recorded-profile` resumes under the checkpoint's own profile revision. Custody is claimed by exclusive create on the recorded generation plus one, and a lost create refuses rather than adopting the winner.

Checkpoints are addressed by the preservation attempt that wrote them, `.cotal/maintenance/v<N>/checkpoints/<attemptId>/<seat>/`, through one shared path helper so the cut and the resume cannot disagree about where they are. A shared per-seat directory made the second cut in a root impossible: the writer refuses a destination that already exists, and deleting the previous one would destroy an artifact a rollback still needs.
