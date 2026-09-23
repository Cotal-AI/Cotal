---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Admit seat checkpoints and take custody on the resume path, before anything starts.

An ordinary `up` from a preserved cut now runs the three admission gates over that cut's seat checkpoints, then claims the seat's next writer generation, all before the resume attempt is journalled and long before a manager launches. A refusal at that point costs nothing; the same refusal after a launch would be a second writer.

Integrity checks presence, regular non-symlink, byte size and sha256, and re-stats after the read. Identity checks the space, that the recorded `lifecycleUid` is not live, and the profile revision against this host's current digest of the seat's launch config, with no override at all: a differing revision is refused naming both digests and the remedy, because the checkpoint carries the recorded digest and not the config bytes, and the manager re-digests the same file at relaunch and refuses drift on its own. Recency compares `capturedAt` to this host's clock against the horizon the record carries, refusing outside it with all three values named. `--accept-stale-checkpoint` admits a stale checkpoint and records the exercised consent in the resume journal with the seat, the capture instant, the admitted age and the horizon.

Admission is all or nothing. Coverage is settled first from the cut's own directory listing, then all three gates run over every checkpoint, and only when the whole set has passed does any generation get claimed. A refusal anywhere leaves every generation unclaimed, including a lost exclusive create inside the claim phase itself: the claims made by that attempt are removed before the refusal is raised, by the exact paths it wrote and nothing else, so a generation another destination holds is never touched. The resume can then be retried over a repaired checkpoint set. Custody is claimed by exclusive create on the recorded generation plus one, and a lost create refuses rather than adopting the winner.

Admission is reconciled against the inventory the resume is about to hand the manager. A retained seat with no admitted checkpoint refuses the resume by name, before any gate runs and before any generation is claimed: an absent checkpoint directory and an absent record look identical to a reader of the directory alone, and a seat that starts without passing the gates has claimed no writer generation.

Two limits are stated in `docs/cli.md` rather than implied. The writer generation is claimed inside one workspace root, so it fences two resumes on one host and not two independent destinations. And no shipped command consumes the captured bytes: the bundle, diffs and untracked archive are written, digested and admitted, but restoring them is manual today, so an ordinary resume still requires the preserved source store.

Checkpoints are addressed by the preservation attempt that wrote them, `.cotal/maintenance/v<N>/checkpoints/<attemptId>/<seat>/`, through one shared path helper so the cut and the resume cannot disagree about where they are. A shared per-seat directory made the second cut in a root impossible: the writer refuses a destination that already exists, and deleting the previous one would destroy an artifact a rollback still needs.
