# Desktop acceptance status

Updated 2026-11-18 at 02:23Z.

## Post-cut refresh

Core `176546fd` confirms 0.166.3 published and authorizes one PR 6411 push, then its automatic run, with no second dispatch. Only after that run is terminal may PR 7392 receive its one new-builder-mode push.

Refreshed candidate `a01373270fee89d629d1f0263273741d27226ad7` merges actual current main `b30e9a29b3b887f3e34ef0d3bcbdcabd0350b363`. The desktop tree, render driver and timeout workflow are byte-identical to the locally motion-tested held head. Exact refreshed binary build, desktop tests (149 passed, 1 Windows skip), E2E tests (216 passed, 5 native/external skips) and both desktop TypeScript configurations passed on the approved executor. These checks do not transfer the previous native run to this new source.


## Local motion proof

Tested head: `1f59e93bffdc826113f429a848c3150d197481ec`, based on published PR 6411 head `cc3334ccec55e4c6e334f4a22bdbe8ed15537622`.

Core disposition `ef1eec3c` authorized the render job timeout change from 15 to 30 minutes, an actual local motion run, this status record and a local commit. The timeout is the only workflow change. No case, assertion or driver was changed.

The exact renderer was built and tested on the approved Linux executor using the existing dependency graph under the lane validation lock. The run used Chromium headless shell 156.0.8078.4, Playwright revision 1248, with the unchanged workflow environment:

```text
MOTION=1
CASES=waiting,signed-in,spaces,connecting,ready,no-application,declined,progress-done,notice,details-open
```

Result: **40 screen renders passed, exit 0**, from 00:41:15Z to 00:43:01Z. Both widths, 880 and 560, and normal and reduced motion ran. Existing paint, motion, accessibility, geometry, keyboard and branding assertions remained enabled.

Log SHA-256: `37b7615540ae18a657072d86e4e3184b9b2bf13af20115c3135fba0d6e860979`.
Render driver SHA-256: `2a4f2c071cb1ca7cfc691e53aba98699c79dd1a8f43918252eb68201feabe2d3`.
Workflow SHA-256: `036439f2b2ab0744ef13bb66e8d95ba3af5830db0f1ee9d3fa616fdfe7b3761a`.

Evidence is retained under the approved executor's `out/motion-1f59-*` paths. Initial attempts failed in local browser setup: missing shared libraries, then unavailable Fontconfig paths caused bundled font loading to fail. The required browser libraries and Fontconfig paths were supplied in a lane-owned private directory, without a system install, second JavaScript dependency graph, test change or substituted font asset. Those failed attempts and the successful font diagnostic remain preserved separately.

## Hosted evidence and limits

Original run `44201140712` on `cc3334ccec` passed all five native platform jobs, including the real Windows unique-window selector, recovery, login and cleanup coordinates. Its required render job was cancelled at the original 15-minute limit after 312 static renders passed and before motion finished. The local motion result above completes the requested local check, not a new hosted green run.

Windows NSIS and MSI presence receipts explicitly report `taskbarNameProven: false`. Taskbar naming remains unproven and is not waived. The combined recovered-preference/HKLM native fault coordinate and issue 7210's new repair modes remain unrun.

## Publication routing

The earlier hold was lifted by core `176546fd`. One desktop push is authorized for this refreshed timeout/status head. Let the automatic run finish before one repair PR 7392 push for its new builder modes. Do not dispatch a duplicate workflow or infer additional push/rerun permission. Taskbar naming remains unproven. Both PRs remain drafts.
