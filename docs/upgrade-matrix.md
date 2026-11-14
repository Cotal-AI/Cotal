# Run the upgrade matrix

> **Project** (non-normative maintainer notes) · **For:** maintainers qualifying Cotal releases

Cotal's upgrade matrix uses the same native harness for release checks and operator diagnostics.
A passing cell requires the target CLI and every recorded extension, status exit0, no paused
recovery record, a preserved ready service when present, and no required repair step. Missing
artifacts, skipped required cells and unsupported states are not passes.

Each cell summary shows the update command's recorded `elapsedMs`, not the whole cell's duration.
Scheduler cells say they are not direct update calls. A cell that fails before updating says no
update call was recorded. Only the Windows `upgrade under test` command has a temporary300000 ms
bound for the slowness tracked in #6817. Restore its180000 ms bound when that issue is fixed.
Other commands and platforms keep their existing bounds.

## Release triggers

The `Upgrade matrix` workflow starts on every opened, synchronized or reopened pull request.
Only a same-repository `changeset-release/main` version PR runs the packed-head phase. It freezes
`pull_request.head.sha` and that head's package version, never the merge ref. Ordinary and fork
PRs record a non-applicable result without running product cells. Head code receives read-only
permissions and no publisher credentials.

After npm promotion, a separate `upgrade-publication` job records and uploads the receipt.
It needs only the completed publish job and runs only when its output says packages were published.
The publish job remains strict. No job depends on the receipt job, so a receipt failure cannot fail
or shorten publication, or delay installation verification and release work.
A separate `workflow_run` consumes the receipt even if a later release-note or installation job
makes the Changesets run red. It verifies the completed run's workflow path rather than its display
name, which can be `Publish packages`. It binds the receipt to the repository, main SHA, run and exact
version, then runs the published phase. GitHub Release creation is not the trigger. A missing
receipt is reported as publication not confirmed, so no published-phase run starts. The publish
job does not retry receipt recording or upload.

The matrix is advisory, not a required check or a merge gate. Maintainers review a version PR's
result when available; a harness fault does not hold a release.

`workflow_dispatch` takes `phase`, `source_sha`, `target_version` and `profile`. Use an immutable
40-character SHA whose package version matches the target. `bounded` is the supported profile.
`extended` refuses explicitly instead of silently running a smaller set. There is no ref-wide
cancellation, so one new head or publication cannot evict an older qualification.

## Required release set

At plan time both phases read public npm metadata and freeze the newest stable published version
strictly below the target. The plan records that source and its registry observation. Missing registry
metadata or a missing predecessor fails without a fixed-version fallback. Each phase runs22 isolated
product coordinates:

| Coordinates | Count |
|---|---:|
| npm fresh, configured and stale-extension self-update on Ubuntu24.04, macOS15 and Windows2022 |9|
| POSIX configured installer rerun and native daemon scheduler |4|
| Native service installed, manual self-update through npm on all three platforms and POSIX installer layouts |5|
| Linux stand-in agent with public stop consent, separately daemon-hosted and standalone |2|
| Linux paused record pointing to a real snapshot under another config home |1|
| Linux host update with a foreign-UID container's bare `cotal supervise` |1|

The manual native-service cells disable automatic updates, install the real service without a Manager
or agent, verify it is ready at the source version, then run `cotal update --self`. Their final daemon
status, installed version, socket and pause/lock records
are sampled independently before cleanup. The census verifies the archived observation hashes and
rechecks the final state rather than trusting the updater's success output. A missing recovery record
or its hash-verified JSON-null clear is healthy; a paused, unreadable or unobserved record is not.
These are separate from unattended scheduler cells. A failed manual service update stays red until fixed.

The daemon-hosted consent cell uses the signed-in participant fixture and the public daemon setup
route. Its endpoint receives the existing user-mode sentinel path and bearer argv from the connector
launch contract. The participant stack includes the real delivery-admin endpoint for retirement.
It must complete the update. Its test-only launcher retains the child's full stdout, stderr and
exit result, plus the Manager's launch request and owned log, before cleanup. Missing or unreadable
diagnostics are recorded explicitly. Console bearer tokens and JWTs are redacted in uploaded logs.
Launch failure remains a failed cell, not a consent result.

Every cell that installs a native daemon collects evidence before updating and again before any
cleanup, including when the update fails or times out. It retains the service's own log, and on
Linux the cell-scoped user journal and selected `systemctl --user show` properties. The final
reading records public daemon status, socket metadata, installed version, update pause records
and lock observations independently of the updater's output. The macOS socket observer accepts the
native `/var/folders` alias only when it resolves to the matching `/private/var/folders` parent,
then checks ownership, the socket leaf and its recorded inode without following a leaf symlink.
The launchd disabled observer accepts native boolean or `enabled`/`disabled` states for the selected
unit. Unknown or duplicate entries remain errors. Missing, unreadable, timed-out or
truncated observations remain explicit. Diagnostics never turn an update failure into a pass.
The daemon-hosted consent failure tracked in [#6822](https://github.com/Cotal-AI/Cotal/issues/6822)
is a product failure, not a known refusal.
The standalone cell starts with `up --detach` and records its
separate consent contract. Container shutdown uses `down --with-agents --yes`. When the bare supervisor is PID1, its clean exit
can terminate the sibling `docker exec` with137. Only that observed case is accepted: the same
container must exit0 between the command's start and the immediately following inspect call's
start, without an OOM, with no process left. Both clocks are compared at millisecond precision.
Other non-zero outcomes and unknown end states fail. Raw exit137 remains in the transcript. Owned Docker shutdown
and its final stopped-state check still run.

The foreign snapshot cell keeps completed rename entries, a freshly recorded paused journal and
an old attempt clock. Its foreign directory and sentinel must remain untouched. The container
fixture uses a real published CLI, open broker and selected space inside its own container. It
waits for `manager up`, records only that owned container's host PID/UID, and checks the foreign
Manager survives the host upgrade. It stops the stock stack and its owned container before
reporting. Before the container starts, a loopback signed-JWT IdP, broker and auth service prepare
a selected remote user-sign-in mesh for the host updater, with no local Manager. That fixture's
readiness and complete teardown are checked separately. Its owned loopback discovery front declares
the test broker's plaintext transport. Registration consumes that fetched, validated document and
asserts the stock trust-policy refresh before a daemon-hosted Manager starts. The production trust
guard is unchanged. The composed hosted container upgrade
still needs its own original result before it can be called a reproduction or a passing fix.

The packed phase builds the exact PR head's six native targets, assembles all24 fixed-group
packages and retains native, prepublish and prepack guards. Its read-only loopback registry serves
the hash-verified candidate closure and installed-version metadata. Candidate version must be newer
than public latest. Installer reruns use the candidate source's receipt-bound script. The published
phase uses public npm and `https://get.cotal.ai` itself, with no script override. Both public latest
resolutions must match the frozen target. If a newer release supersedes it, the cell fails rather
than certifying the wrong version.

Each cell runs in a fresh disposable hosted runner. The release matrix admits all22 required
product cells concurrently, so a macOS queue does not consume a workflow-wide slot needed by Linux
or Windows. GitHub runner availability still controls when a job starts. The six native builders
retain their separate concurrency limit. Artifact timestamps record actual durations; neither the
workflow limit nor the per-job timeout is a publication-time guarantee.

## Exclusions

There is no Windows shell installer, so its installer-layout manual-service coordinate is explicitly
excluded. Windows npm manual-service update is required. Windows scheduler upgrade remains excluded until its product
implementation has native acceptance; native task or job-object facts do not establish that.
The optional candidate-A reverse path, all historical source versions, concurrent replacement,
missing-snapshot recovery and wider agent combinations remain diagnostic coverage rather than
claims in the bounded release set. Existing red artifacts are retained when a later fix passes.
Six native package builders prove closure, not six platform upgrade paths.

The summary compares the complete expected coordinate to its evidence, checks exact layout,
state, method, source, phase, target and candidate origin, and rejects duplicate or absent results.
Configured states require a real prior extension inventory. A fresh report cannot be relabelled as
a configured pass. Every required cell needs its own positive assertions, not an aggregate job exit.

## Known refusals

`scripts/upgrade-matrix-refusals.mjs` binds each listed coordinate and source range to a public issue,
command exit, complete refusal transcript and failed-assertion set. Only typed fixture identifiers may
vary. Source, artifact, safety and cleanup guards run before matching. Unknown refusals, changed text,
extra failures and listed cells that turn green fail the summary. A green listed cell requires retiring
the entry. Raw reports stay failed. The census reports expected refusals separately from genuine
upgrade passes, with separate summary acceptance and full upgrade acceptance.

The standalone consent entry names [#6802](https://github.com/Cotal-AI/Cotal/issues/6802). The container
entry names [#6785](https://github.com/Cotal-AI/Cotal/issues/6785) and applies only to source0.164.6;
source0.164.7 must pass. The recovery entry names [#6747](https://github.com/Cotal-AI/Cotal/issues/6747).
Entries with no released fix use `fixedIn: null`. Set the cutoff only when a release carries the fix,
then remove stale entries when their listed source turns green. A packed target fix does not change
which installed source executes the first update attempt.

## Run a published cell

Use Node>=22.10. Native service and agent cells require a disposable hosted runner. On a persistent
Linux host the harness refuses them and places other cells in private mode700 homes under
`/var/tmp/upgrade-matrix`. It never uses the operator's Cotal state. Require20GiB free before
installation or build. Do not run the container fixture on a workstation.

```sh
node scripts/automatic-update-platform-baseline.mjs --list linux
node scripts/automatic-update-platform-baseline.mjs --source <source-version> --layout npm --state configured --method self --expected-target <version> --output ./upgrade-evidence
node scripts/automatic-update-platform-baseline.mjs --summary ./upgrade-evidence
```

`--expected-target` freezes public latest at both resolutions. Omit it only for an explicitly
runtime-latest diagnostic. A same-version result is not a version-changing upgrade. Optional shell
completion and pre-existing PATH guidance stay in the transcript, while actual restoration,
unknown outcomes and required repair commands remain red.

Historical diagnostics can pass `--expect-policy-refusal legacy-seat`, `unsupported-scheduler` or
`missing-config` only on their reproduced source, layout, platform and state. These controls retain
the refused or unsupported upgrade result and report policy acceptance separately. The missing-config
control records the 0.160.7 refusal, then reruns the public installer into the original prefix and
checks its target version, seeded connectors, status and recovery state. None of these controls
accepts the newest-version repair hint or turns an unsupported scheduler into upgrade acceptance.

## Pack a candidate

Use the existing guarded packer through the harness, with the complete source-matched native
inputs already assembled:

```sh
node scripts/automatic-update-platform-baseline.mjs --pack ./candidate --version <candidate-version> --source-root <clean-git-root>
node scripts/automatic-update-platform-baseline.mjs --candidate ./candidate --direction B --source <source-version> --layout npm --state configured --method self --expected-target <candidate-version> --output ./upgrade-evidence
```

An explicit source root must be a clean actual Git root. Its own packer is imported. Version-only
rewrites are restored in `finally`; tracked edits and untracked product inputs refuse admission.
Direction B upgrades published source to a newer packed target. Direction A installs a below-public
candidate and takes a newer public version, serving metadata for the installed candidate too.
Never relabel an older archive or patch installed product bytes to manufacture a transition.

## Observe native custody

Mac scheduler transition cells require a stable source at least0.164.6 and a newer explicit target.
They use `--published-launchd true --launchd-proof transition` for a published target and the same
transition observer for candidate B. Snapshots retain receipt, plist bytes
and digest, loaded job, runner creation identity, completion, exit, job/source retirement and daemon
generation. A terminal success alone does not establish custody cleanup. Unknown custody retains
the service for disposable-runner teardown. Off-before-tick and killed-before-result modes remain
available in the scoped candidate-A diagnostic campaign.

The scheduler cells observe automatic-update eligibility for at most90seconds after the daemon
answers, on Linux and macOS, before aging any clock or starting the upgrade observation. Readiness
alone does not establish native ownership. The eligibility samples and deadline remain in the report;
a deadline failure remains red and does not become an updater result.

Each candidate cell starts its own registry. After confirmed native removal, it restores unchanged
owned npm configuration before stopping the registry. A changed configuration is retained. Native
Windows baseline probes separately record policy ticks, demand task lifetime and inherited lock
facts. An inherited handle was observed not to retain its owner's LockFileEx lock after owner
death, so that fact is not accepted as a mutator-lifetime barrier. Job-object ordering probes must
report any grant while a descendant lives, without adding a wait that hides the interval.

## Extend a composition

A program importing `matrixCell` may supply an in-process `prepare` callback. After source setup,
it receives the private environment, project, installed package, call recorder and report. It may
return an async disposer, which runs in `finally` before reporting. A prepare failure must clean
anything it started before throwing. This composes stock IdP, broker or remote-user fixtures over
the same updater path; it does not add a second installer harness. Never pass callback text through
CLI arguments. Tests run with `pnpm smoke:upgrade-matrix` in ordinary CI.
