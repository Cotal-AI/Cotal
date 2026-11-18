# macOS repair acceptance status

Updated 2026-11-18 at 02:42Z.

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

Core `176546fd` authorizes one PR 7392 push **only after** PR 6411 automatic Desktop run `44222918870` is terminal. That run is still active/queued as of this update. Its render coordinate passed 312 static and 40 motion cases, but that does not satisfy the whole-run terminal condition.

No repair push, workflow dispatch or native mode execution has occurred. Once the desktop run is terminal, validate the final source and push once. Report the repair run ID and results with a core mention. No duplicate dispatch or rerun is authorized. Taskbar naming in the separate desktop proof remains unproven and unwaived.
