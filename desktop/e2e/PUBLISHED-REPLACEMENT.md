# Published desktop replacement measurement

Never merge this branch or open a pull request. It was cut from desktop fixture head `dc33ed267ad3b0f0b263f2388e8838cc5fb468c9` to reuse native window helpers, but runs no fixture context, sign-in, broker, Manager or debug product code.

Dispatch `.github/workflows/desktop.yml` on `measure/desktop-installer-replacement`, with no inputs. It contains only workflow_dispatch and four published-installer cells: macos-15 arm64 and windows-2022, each window-open and service-only. At most two run concurrently. It downloads published 0.164.6 and 0.164.7, verifies GitHub asset digest/length, installs N in the default location, invokes its bundled stock daemon install/status, performs N+1 normal package replacement, records opened bundled files/modules and content/inode changes, then quit/reopen-only outcome. If reopen does not recover, it records stock start followed by stock uninstall/install recovery separately, never conflating that with reopen success.

The measurement uses real default homes only on disposable GitHub-hosted runners, as explicitly authorized by cotal_app. It creates no key, reads no credential files, and does not log process command lines. Windows Handle is query-only, PID scoped, obtained from Microsoft and required to have a valid Microsoft Authenticode signature. macOS uses lsof name-only output. The harness imports no installed native module, avoiding an artificial second file locker.

Original result.json, before/after full file inventories, per-file change classification, native window/AX screenshots, service status transcripts, installer output and stock recovery/cleanup observations are uploaded in desktop-replacement-<OS>-<mode>. A nonzero installer can be a measured product refusal, not a passing self-update claim. Missing observations fail the cell. Unknown timed-out installer ownership blocks cleanup and retains the install for runner disposal. Otherwise cleanup uses stock receipt-guarded daemon uninstall, endpoint/native absence checks, native app quit, then the owned app uninstaller/removal and DMG detach.

Local checks are syntax/YAML only, not platform acceptance. Core dispatches and relays artifacts to the lane out directory. Only after reading originals may the writer and owners choose an apply order.

Sources: https://learn.microsoft.com/en-us/sysinternals/downloads/handle and https://support.apple.com/guide/mac-help/install-and-uninstall-other-apps-mh35835/mac .
