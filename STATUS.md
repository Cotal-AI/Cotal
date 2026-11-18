# Exact preserving orphan measurement status

Updated 2026-11-18 10:32Z. Urgent core request 8996 supersedes the earlier no-push freeze for this lane: push and verify are authorized, core dispatches and merges. The owner's Mac is untouched.

## Current published CLI behavior

Published 0.167.0 tag 98f0e29d632eb2ff3abe7476872d610d22e81c85 and current main 907cb9dc4aa6c587d8d0f55a7c706aa4fbb57c77 have byte-identical execution-preinstall and preserving-observation code. Plain update --self calls its installed readExecutionPreinstall floor before targetExecutionPreinstall, at execution-update.ts lines 67-68. Main has no repairMissingInstalledProgram hook. A persistently preserving old Manager therefore still refuses before target admission, with exit 1:

```text
staged pre-install check refused: manager is in preserving mode; hold age <age>; seats <count-or-unknown>; update owner <owner>. Wait for a running update to finish, then run `cotal update --self` again. No hold was released by this check.; no installed packages or connector state were changed
```

Only a bounded read-only reobservation is allowed on proved zero seats and gone/transaction custody. No old fence is released by that floor. The 0.166.2 dead-updater reaper is new daemon code and cannot enter the owner's already-running 0.163.2 daemon. Existing installed 0.165.1 likewise refuses in its own older floor before the downloaded target's admission code. A staged target may be downloaded/version-verified already; this is not target repair execution.

## What 7392 changes and what remains unproven

7392 calls explicit Darwin plain update --self repair before its own updater floor. The old 0.163.2 already-prepared daemon path can add the repair's authenticated owner and acknowledge preparation. The repair then requires verified recorded plist/receipt/native job/PID/birth, durable intent, native old job retirement and original lifetimes gone, exact replacement publication, fresh native lifetime and answering hosted Managers. That is conditional reachability, not native proof on the owner's preserving state. It does not retrofit an already-refusing 0.165.1 process merely as its downloaded target.

Prior native run 44244163456 at 69dff had six passing modes including plain A-to-B self-update on a released 0.164.16 answering/idle Manager. It did not create the owner's old 0.163.2 abandoned preserving state. Its unreadable-Manager new-work path failed issue 7472 and cleanup remained unconfirmed. Those limits stand. Separate diagnostic 7481 is not included here and is not functionally required for the preserving mode to pass.

## Prepared exact-state measurement

Current local candidate merges main 907cb9 into repair 7392 plus fixture commits a0960494f and 65dc3d447, product merge 9c43a5c0e. No speculative product fix was added. New preserving-self-update mode:

1. Installs official integrity-verified npm cotal-ai 0.163.2 in an explicitly attributed app-shaped runtime under /Applications/Cotal.app and copies the runner's real Node executable, recording file identities/hashes. Release v0.163.2 has no signed desktop app asset, so this is NOT represented as a signed historical app.
2. Uses old shipped public daemon install/setup and a real participant to create the recorded native job and Manager.
3. Uses old shipped authenticated managerViaDaemon from a short-lived helper to prepare restart, records helper PID/birth and confirms exit. No fence or intent file is manufactured. Requires old daemon restartEvidence prepared, one fenced zero-seat Manager, same original PID/birth and actual instance-pinned Manager preserving refusal before and after app original-path retirement.
4. Runs official published 0.167.0 plain update --self toward the newer B registry target first. Requires actual preserving floor refusal, no timeout/no-op, protected file bytes and native PID/lifetimes unchanged. The unchanged claim is bounded to the six named files, native observations and preserving proof, not a full package-closure postread.
5. Runs installed guarded repair candidate A plain update --self to B, before any candidate daemon status. Requires fresh native job/installed B, original daemon and Manager exits before cleanup, unchanged sign-in/receipt-bound source outside app, answering hosted Managers, real native restart and exact cleanup. A failed setup is not a repair result.

All original twelve signed-app modes remain selectable via all. New workflow_dispatch input defaults to preserving-self-update and keeps six exact-source builders, four native receipts, full normal 24-package A/B guards, isolated Mac runner and exact 30 GiB floors. New measurement ref is measure/macos-preserving-self-update, not an automatic push trigger. Core owns dispatch.

## Validation and dispatch prerequisite

Outer JavaScript syntax, YAML/manual selector/serial/fail-fast/native builder structural checks passed. Independent source review found no hard setup blocker, with native payload/runtime execution explicitly unproved. Both workers completed without resources and were stopped.

The first local build command wrongly used root tsc -b against the include-all root config, causing setup/type errors and adjacent emitted files. Those 11,752 attributable owned graph outputs, 95,399,657 bytes, were moved to evidence under the exclusive graph lock, not deleted. The maintained topological full project build then passed on exact product/fixture merge 9c43, followed by the binary full smoke-tree TypeScript check and repair replies 3 of 3. Exact-source docs voice, literals and comments passed. The STATUS-only successors do not change tested product, fixture or workflow bytes. No new install graph or system changes. Old logs preserved, no main/product regression claimed from the wrong invocation.

GitHub's manual dispatch requires workflow registration on the default branch. The dedicated workflow does not exist on current main, confirmed by git/API and GitHub documentation. Core was informed. The prepared branch can be published, but core must register/merge the workflow on main or supply an existing registered dispatch route before running it. No self-dispatch or owner-Mac operation occurred. Exact-state native acceptance remains UNRUN until the real Mac run produces original proof.
