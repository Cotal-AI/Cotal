# Run the upgrade matrix

> **Project** (non-normative maintainer notes) · **For:** maintainers qualifying Cotal releases

The [workflow](../.github/workflows/automatic-update-platforms.yml) runs published upgrades on
Ubuntu 24.04, macOS 15 and Windows 2022. It records the selected release, each command's output,
assertions and SHA-256 evidence. A failed or unsupported setup is never a passing upgrade.

## Run a published cell

Use a disposable machine with Node 24 and npm. On a persistent Linux machine, the script creates
private homes under `/var/tmp/upgrade-matrix` and refuses native-service and live-agent rows.
It refuses installation when fewer than 20 GiB are available. It does not delete test roots.

```bash
node scripts/automatic-update-platform-baseline.mjs --source 0.164.0 --layout npm --state fresh --method self --output ./upgrade-evidence
```

Sources are `0.155.0`, `0.160.7`, `0.162.0`, `0.163.5`, `0.164.0` and `latest`.
Layouts are `npm` and `installer`. States are `fresh`, `configured`, `daemon`, `agent`,
`stale-extensions`, `recovery` and `concurrent`. Methods are `self`, `scheduler` and `installer`.
Each published cell resolves npm's current latest release without a registry overlay.
Print the full coordinate census and exclusion reasons with `node scripts/automatic-update-platform-baseline.mjs --list linux`.
There are 138 applicable coordinates per POSIX platform and 48 on Windows, before historical-state support is checked.

The Windows installer is excluded because none exists. Installer reruns apply only to installer
layouts. Scheduler cells require the daemon state. Release 0.155.0 cannot prepare automatic-update
settings through its CLI. macOS and Windows scheduler refusals remain visible rather than becoming
silent skips. Recovery and contention preparation use labelled fixtures, followed by real commands.

The daemon scheduler runs in the disposable runner account's normal home. Its real service owns
the daemon. Only cached clock fields are changed, with before and after evidence. The harness never
calls the updater on behalf of the scheduler. Receipt checks guard service removal. Unknown native
outcomes are retained for runner teardown rather than retried blindly.

## Qualify an installer change

For shell-only changes, keep the installed CLI and npm target published. Pass an inspected script
with `--published-installer <path> --installer-source <commit> --installer-sha256 <sha256>` on an
installer-layout rerun. The source must be a full commit ID and the script digest must match.
The initial installation still uses the public installer. The result records the override separately.
This option refuses candidate tiers and does not change their source-matching checks.

A paused-snapshot refusal control may add `--expect-recovery-refusal true`. It requires exit 1,
the reconciliation failure and repair command, `OPERATION_UNKNOWN`, and no final installation
summary. The upgrade result stays `failed`; a separate `expectedRefusal.passed` field records the
fail-closed check. Only that explicit control may exit zero for an expected failed upgrade.

## Test a packed candidate

Build the workspace and assemble source-matched native artifacts as the workflow does. The same
script calls the existing complete-closure packer, preserving its native release guards.
During version-only bootstrap rewrites it uses pnpm's warning-only dependency precheck, preventing
an automatic dependency reinstall. Prepublish, prepack and source-matched native checks still run.

```bash
node scripts/automatic-update-platform-baseline.mjs --pack ./candidate-B --version B
node scripts/automatic-update-platform-baseline.mjs --candidate ./candidate-B --direction B --source 0.164.0 --layout npm --state fresh --method self --output ./candidate-evidence
```

B tests a published source updating to the packed head. `--version B` derives the next patch above public latest.
`--version A` derives a lower stable version for the later self-upgrade proof. Numeric versions may also be supplied.
Each cell checks the required ordering again before installation.
Every result labels its local registry as synthetic. Third-party dependencies come from npm, while
every first-party package comes from the candidate archives. Archive hashes and temporary manifest
changes are recorded. Installed files are never rewritten. Never publish these bootstrap archives.
The pack also records `installer.sh` and its source/hash receipt. For a candidate installer rerun,
pass `--candidate-installer ./candidate-B/installer.sh`. The harness verifies that receipt against
the packed closure before execution. Published rows always download the public installer.

A tests whether the candidate can update itself later. Pack it separately with a stable numeric
version below public latest, then pass `--direction A`. The overlay supplies metadata and archives
for that installed candidate version while keeping npm's real latest target. This satisfies both
the stock version comparison and the updater's installed-version metadata lookup.

## Keep desktop custody separate

The Linux desktop-beside-CLI job uses the existing v0.164.2 release workflow's desktop package,
verifies its published digest and every bundled runtime file, then installs that runtime's real
native daemon on the disposable runner. A separate npm CLI updates through its own prefix.
The cell requires the desktop service source, runtime bytes, version and desktop update channel
to stay unchanged. It does not build a desktop or substitute a desktop marker fixture.

## Read the result

A cell passes only when the CLI and recorded extensions reach the target, `cotal status` succeeds,
no paused recovery remains, an existing daemon stays ready and no manual remedy is printed.
The JSON identifies failed assertions and the transcript preserves the text a person saw.
Optional shell-completion profile notices are retained verbatim in `advisory`. They do not fail an
otherwise consistent installation. Required repair commands and a warning that PATH does not select
the installed CLI still fail the no-manual-step assertion.
Combine downloaded cell artifacts with `node scripts/automatic-update-platform-baseline.mjs --summary ./upgrade-evidence`.
For a release that supports scripted stop consent, add `--stop-agents true` to the harness command.
This passes the public updater flag without answering a prompt on the person's behalf.
A same-version run is recorded separately from a version-changing upgrade. Keep red results when
qualifying a release and route product defects to their owners rather than repairing product code
inside the harness.
