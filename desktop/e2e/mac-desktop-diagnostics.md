# Native acceptance fixture contract

`mac-desktop-diagnostics.mjs` is not a standalone e2e runner. It is an assertion sequence for an isolated native app. Do not report it as executed acceptance.

Required caller inputs:
- `app`: an app bundle under the disposable GitHub runner's RUNNER_TEMP.
- `driver`: a compiled `desktop/test/mac-updater-driver.swift` AX driver.
- `output`: artifact folder.
- `screenshot(path)`: native window capture.
- `fixture(action)`: controller for the isolated daemon state, with these actions:
  - `ready`: one connected and one unconnected catalog space, service ready.
  - `assert-connected-option-disabled`: inspect the actual open native picker AX tree. Assert the connected space is absent or AXEnabled=false, never infer from DOM hidden.
  - `hold-status-and-select-unconnected`: hold status reply, select the remaining space through native UI.
  - `assert-add-disabled`: inspect Add AXEnabled=false while status reply is held.
  - `release-status`: release and await status completion.
  - `unknown-refusal-after-ready`: return NEW_SERVICE_REFUSAL with exact fixture message and remedy, await refusal card.

The isolated daemon log must contain `fixture service log reason`. The caller must also test a >5 MiB log and a service appending during read. No account sign-in, owner Mac, or installed personal service is authorized by this helper.

Current limitation: no implementation of the fixture controller exists in this change. Browser coverage uses the built renderer with the existing native stub, not native Tauri acceptance. Desktop apps CI must compile/test the Rust Log variant independently.
