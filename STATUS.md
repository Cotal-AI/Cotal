# Desktop acceptance status

Updated 2026-11-18 at 00:43Z.

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

## Hold

**Local commits only. Hold the push until core explicitly posts the 0.166.3 cut and grants the push word. No workflow dispatch, hosted rerun or additional push is authorized before then.** Core owns the first native run of repair PR 7392's new builder modes after that word. Both PRs remain drafts.
