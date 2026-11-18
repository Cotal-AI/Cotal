# macOS repair acceptance status

Updated 2026-11-18 at 04:09Z.

## Prepared first native run

Local candidate `14d6598cb4265b26c8a51e590250e19947ed8ea4` merges current main `b30e9a29b3b887f3e34ef0d3bcbdcabd0350b363`. The published PR 7392 head remains `f6006204ce3e0fffcc128d761c9ae590327ab4e3` until the authorized serialized push.

The prepared workflow checks out the exact pushed source on six native runners and builds the Linux, macOS and Windows x64/arm64 seat helpers plus the four source-receipted workspace bindings. It assembles and checks the normal native closure, packs all 24 packages as candidate A, then uses a separate clean checkout and the normal next-candidate packer for candidate B at A.patch + 1000. No previous release binary is relabelled and no package/native guard is bypassed.

The macOS measurement jobs run one at a time on isolated hosted runners, with fail-fast enabled. Their modes are status, install, disabled, unreadable-source, self-update, unreadable-manager, occupied-manager, crash-prepared, crash-published, crash-prepared-mismatch, crash-prepared-concurrent and crash-prepared-changed-source. Each runner checks the exact 30 GiB free-space floor before setup. A runner below the floor fails setup rather than weakening that requirement.

## Local validation

At the named candidate, the approved executor's existing dependency graph passed the full build, binary source and smoke-tree TypeScript checks, repair replies 3 of 3, update generation 57 of 57, and native adapters 378 of 378 including real built public-entry chains. Docs voice, literal and comment checks and the changeset plan passed. YAML structure, all 17 Bash blocks and embedded JavaScript syntax passed. These are local checks, not macOS native acceptance.

Independent source review found no further concrete A/B/source-cleanliness/observer-install execution blocker. It noted that the required 30 GiB admission may exceed available space on some hosted runner images. Actual hosted admission remains unmeasured. The floor is retained. Both preparation/review workers completed without jobs or runtime resources and were stopped.

## Remaining native limits

**All new native modes remain UNRUN.** This status does not transfer old `fc9872708c` native evidence to the new source. Real phase capture can be missed and must fail setup without inventing an intent. Distinct-destination receipt normalization and old Manager deleted bearer-entry resolution remain risks to measure, not speculative product fixes.

Concurrent-operation assertions cover the actual suspended repair child, protected bytes and lock owner, not continuous native-job or all-process preservation. Changed-source restoration requires an isolated no-concurrent-writer fixture premise plus exact descriptor/path ownership, protected authority, native absence and exact fault bytes. Partial publication or unknown cleanup stays failed, with disposable runner teardown owning unknown survivors. No live agents are killed to make an update proceed.

## Serialized publication authority

Core `176546fd` authorized one PR 7392 push after PR 6411 run `44222918870` ends. Core `37c57459` subsequently tightened this gate: the Intel cancellation was a lost runner, core will rerun failed jobs once, and PR 7392 must wait for that rerun to end as well. Initial attempt 1 ended cancelled with only Intel lost before capture. Core's retry, attempt 2 on exact desktop head `ebe88aded09bf646bde51b7228d733944a2b8829`, is now terminal SUCCESS, confirmed at 04:06Z. New Intel launch, account and presence originals were independently SHA-256 verified before grading. The serialized publication prerequisite is met.

No repair push, workflow dispatch, rerun or native mode execution has occurred as of this status commit. Core's retry has ended, so the validated repair head is authorized for its one push. All new repair modes remain unrun. Core `86074c80` instructs the lane to report both automatic run IDs immediately: the dedicated builder workflow and the ordinary Desktop apps workflow. Core, not this lane, will cancel the ordinary Desktop workflow to preserve capacity. No duplicate dispatch or agent cancellation is authorized. Taskbar naming remains unproven and unwaived.
