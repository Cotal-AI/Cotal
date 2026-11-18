# macOS repair acceptance status

Updated 2026-11-18 at 05:16Z. PR 7392 remains draft and not merge-ready.

## Actual native result

Published head `7ad8a7d86cd68dbb713ac7fc4ecc7021f4264d6a`, dedicated run `44235279384` attempt 1, is terminal FAILURE. Six exact-source builders and both normal guarded full 24-package candidate packs passed. Independent original audits verified ten native ZIPs, four source/binary receipts, all archive hashes and 4,307 actual file hashes per pack. A is 0.166.1003, B is 0.166.2003, packed on distinct clean runners. Normal native and prepublish guards and mandatory 30 GiB floors passed.

Five native modes passed and were graded from API-hash-verified originals: status, install, disabled, unreadable-source and installed A-to-B self-update. Unreadable-Manager failed. Occupied-Manager and five crash variants were cancelled before execution by the mode matrix's fail-fast, all six remain UNRUN. Old evidence is not transferred to those cases. The fixture proves absent original app/program paths after retiring the bundle, not deletion of the renamed inode while old processes run.

The failed job is `134578230027`. Original artifact `14400361083` SHA-256 `4d8357f7311435f54fe67aed9b225d5ff427fd329c7f38450c9f3f3934e5810c` independently matched the API before inspection. Its original ZIP, API snapshot, actual job JSON/log, failure checker and output are sealed on the approved host in `out/repair-44235279384-modes/`. The checker confirms an expected failure signature, not passing acceptance. The full failure grade is retained as `GRADE-44235279384-UNREADABLE-MANAGER-FAILURE.md` in lane evidence.

## Finding A: designed safety refusal, poor user diagnostic

The actual Manager 9494 was pinned by native birth, suspended with SIGSTOP and observed in state T. Candidate `daemon install --json` refused with exit 3 and `OPERATION_UNKNOWN`, message `the pinned daemon refused service repair preparation`. It did not time out. Original daemon 7829 and Manager 9494 identities, plist, receipt and sign-in assertions remained unchanged, and no repair intent was published. After same-lifetime SIGCONT, instance-pinned public `ps` answered.

Refusing to stop an unreadable Manager is designed safety behavior, as documented in `docs/cli-processes.mdx` at the background-service repair description. The released 0.164.16 daemon's `generationCall` bounds its unanswered inspect at 10 seconds and `managerResult` sends `MANAGER_UNAVAILABLE` with a recovery remedy. The candidate's `bin/daemon/install.ts` request helper discards that negative reply at line 575 and throws a generic Error. The shared CLI maps generic errors to unknown. That loses the useful Manager cause and remedy. This is a user-diagnostic defect, not evidence that the service should have been stopped or that the safety refusal failed. No product fix was made.

The actual native JSON contains outcome unknown, completeness not-checked, null result, no cause/remedy, empty stderr and exit 3. The same built public report helper was exercised read-only with the observed failure and renders:

```text
Outcome unconfirmed
  the pinned daemon refused service repair preparation
  Outcome: unknown
  Code:    OPERATION_UNKNOWN
```

The render is evidence of the existing human renderer, not a second native mutation. The user sees no actionable restoration instruction or affected Manager in this path. Preserve conservative unknown semantics until any outstanding preparation/abort effects are classified; do not blindly turn every negative reply into a known no-effect refusal.

## Finding B: real user-reachable missing-runtime peer resolution

Actual new lifecycle `spawn --on <original-instance>` exited 2 with `LIFECYCLE_BLOCKED`, native failed-precondition/not-executed. The reason is the ordinary fixture connector's `@cotal-ai/core` peer cannot be linked. Public read recovery is not lifecycle admission, no seat receipt was produced, and the full unreadable-Manager acceptance field was never written.

This is not merely an invalid fixture declaration. A real operator-installed custom connector declares the same peer and is lazily loaded on its first use in that Manager. The real launch path calls materialization, `bindExtensionPeers` and `realpathSync(hostPackageDir(peer))`. That host resolver walks the still-running Manager's original module installation, whose app path no longer exists. CLI `ext add` registration does not preload the connector into the separate Manager. The native fixture used those actual public entry points and reproduced the user-visible failure. Independent read-only source review confirmed the chain and owns no resources.

Filed https://github.com/Cotal-AI/Cotal/issues/7472 with exact public steps, original hash and limits. This is scoped to first-use custom connector loading with missing original runtime paths. It does not prove all seeded or already-materialized connectors fail, nor that replacing the app with a complete new runtime at the original path has the same result. The native measured sequence includes suspension/refusal/resume, and a no-suspension variant was not run. It is not a lifecycle-fence regression diagnosis. Removing the fixture's peer declaration alone is not a valid proof fix: it would hide a real route and still leave a separate bearer command pointing at the retired app entry. No product or fixture edit was made.

## Finding C: cleanup harness state defect and minimal proposal

The fixture sets `occupiedInstance` before public spawn. Spawn proves not-executed, but no seat PID/birth/lifecycle is captured. Cleanup interprets the selected instance as an owned seat, fails `no seat stop without its captured native lifetime`, then correctly refuses daemon/Manager signalling. It reports unknown service and unresolved processes. Final census retains daemon 7829 and Manager 9494. Cleanup is UNCONFIRMED. Disposable hosted runner teardown owns unknown survivors, but fixture evidence does not prove teardown completion. This lane sent no cleanup signal.

The harness defect is conflating selected/pending admission with an owned live seat. Smallest safe correction proposed, not implemented here: track pending admission separately; clear it only after attributed request/native not-executed evidence and unchanged original-instance inventory; mark cleanup-owned only after native PID/birth and public lifecycle UID are captured. A proven not-executed admission needs no seat stop, so existing receipt-bound service and pinned-process cleanup may continue. Unknown admission, timeout, malformed reply or missing native ownership retains today's refusal and teardown ownership. Do not simply test `if (occupiedSeat)` or assign the instance after spawn succeeds, which would discard ambiguous launch ownership.

## Local workflow change and authority

Core `dd37ec3e` requested mode fail-fast off. Local commit `468136019` changes only the measurement matrix to `fail-fast: false`. `max-parallel: 1`, all 12 isolated modes, native-builder fail-fast and exact 30 GiB floors remain unchanged. YAML parsing and structural assertions and `git diff --check` passed. This prepares independent execution of later modes, not a waiver of failed cleanup or acceptance. It has not run natively.

The earlier publication grant was consumed at 7ad8. Core explicitly says no rerun and no new push yet, and will give the push word after this three-finding report. No dispatch, rerun, agent cancellation or source push followed the failed run. Ordinary Desktop run `44235285286` was cancelled under core-owned routing. Desktop PR 6411 exact ebe88 run `44222918870` attempt 2 passed, but taskbar naming remains unproven and unwaived, and combined recovered-preferences/HKLM native fault remains unrun. Main's `.internal` pointer remains untouched. Keep the lane seat until core closeout.
