# 10820

Only the person-typed `cotal daemon install` in `bin/daemon/command.ts` calls `applicationsBeyondService` and `refreshInstalledApplications`.

`applyInstall` callers that do not reach that branch:

- `bin/daemon/setup.ts` calls `applyInstall` during setup.
- `bin/daemon/desktop.ts` calls `applyInstall` for the desktop app.
- `cotal update` does not call `applyInstall`.

`refreshInstalledApplications` returns on anything other than Linux `systemd-user`. `planInstalledPathRefresh` can prepare a `launchd-agent` rewrite, but this branch never calls it on macOS. Launchd was not changed.

PR 10736 (`fix/keep-seats-on-oom`) also edits `bin/daemon/install.ts`. Its skip rules live in `bin/daemon/install-linux-repair.ts`: hand-edited digest, custom settings, drop-ins, pending reload, another loaded unit needing reload, held repair lock, another installation, missing `systemctl`, and a silent user manager. This branch touches `recordedUnit`, `planInstalledPathRefresh`, and the new refresh below them. It reuses the loaded-unit fields (`DropInPaths`, `NeedDaemonReload`, `FragmentPath`) and leaves those units unchanged. Whoever lands second rebases. `fl_fx_10816` also edits `bin/daemon/install.ts`.

A unit whose receipt, digest, loaded path, drop-ins, or pending reload does not verify is left unchanged. A running agent defers the refresh and changes nothing.
