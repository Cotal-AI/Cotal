# Cotal desktop

The Tauri app controls the stock `cotal daemon`. It bundles that CLI and Node 24, so end users do not need a terminal, Node or npm. The app and CLI use the same daemon, sign-in and space registry. Closing the window hides it in the tray; quitting the app leaves the installed daemon running.

## Use

Open Cotal and choose **Continue with Cotal Cloud**, or **Use another Cotal host** to enter your installation's sign-in URL. The welcome explains who can launch applications as your user. Continuing prepares the background service if needed and opens browser approval, with a code and a button to reopen that page. Your login stays in the background service, never in this app.

On account-computer hosts, successful sign-in opens **This computer is connected to your account** with **Open dashboard** to turn on spaces. The header reads **Ready** with no enabled spaces, **Connected** when a space answers, and **Sign in required** after account sign-in expires. Removing all spaces keeps **Ready** and shows **No space is using this computer**. Connected dots are green, starting or waiting dots gold, and actionable refusal or sign-in dots red.

On hosts without account computers, the four steps are Welcome, Sign in, Connect and Ready. After approval the app selects the space named by an onboarding link, otherwise the personal space, otherwise the account's only space. Several team spaces without a personal one show a compact choice on Connect. The confirmation names the space before **Connect this computer** runs setup with five named progress steps. Nothing connects before that click. Original diagnostics and exact refusals stay under a closed **Details** disclosure.

While waiting for the browser, copy the approval code with **Copy** and watch its countdown. An expired code offers **Get a new code**. A replacement waits for the old native sign-in to settle, so two sign-ins never overlap. Approval advances the app automatically. Missing applications, declined sign-in, an unreachable host, empty accounts, pending owner approval, active sessions and version mismatch each show a recovery action. Details keeps the original diagnosis.

Step changes fade in with a small movement. Progress markers show waiting, running and completion, and the running row says what is being checked. Details and notices expand in height. Reduced motion removes movement and continuous animation. Enter invokes the current primary action, Escape closes Details, and one polite live region announces state changes. Background refresh preserves focus, typed fields and unchanged progress nodes.

Later opens show **Spaces using this computer**, the same list as Ready. Each row names a space and its kind, with **Remove** to disconnect it. **Add to another space** shows the account's other spaces and a separate confirmation before connecting. Pending owner approval stays in the space's row. If every space is waiting, the gold clock view names the owner approval and hides the empty application list. Account-computer hosts keep Open dashboard available while approval is pending. Open dashboard, Open at login and the version remain available. The window defaults to 880×660, with a 560×660 minimum. The paper theme and local icons are unchanged. The background service runs as the operating-system user after the window closes. Removing a space stops its Manager and machine-service connection without revoking remote grants. On hosts with account computers, Connect and Remove update the same desired space list as the dashboard. Ready reads daemon account status and shows connected, starting, waiting for approval, locally removed and refused spaces. Sign-in expiry stays on Ready with a primary **Sign in** button. Hosts without account computers report per-space mode and keep local connections.

Refresh reads hosted Manager readiness. Account-computer status refreshes each second while the window is visible, so dashboard changes arrive after the daemon's five-second desired-set poll. Per-space hosts refresh every ten seconds. A connected machine service alone is not launch-ready. While the selected space is launch-ready, Connect this computer is disabled. Delayed status replies cannot replace a newer action or selection. A missing application refusal names the supported applications and offers **Check again**, which runs the same setup again.

The `setup-progress` frame carries additive `progress` metadata (`step`, `outcome`, `detail`, and application names for the application check) from setup's own records. The renderer does not infer steps from terminal sentences. Terminal report lines are unchanged. Missing service on first open is a neutral setup state, while real refusals retain their exact reason and remedy in Details.

The app runs the stock `cotal daemon setup --space <space> --idp <url>` operation through its closed native boundary. Setup reconciles stock connectors, prepares the hosted Manager's default persona, and hosts that space's Manager. Machine-service registration and owner approval remain separate and do not delay launch-readiness. The daemon restarts hosted Managers after crashes and resumes them after its own restart. Disconnect removes that intent. The terminal's `--no-manager` keeps the connection-only path.

On macOS and Linux the bundled CLI reads PATH from the account's interactive login shell with a bounded native call. It keeps only PATH, validates absolute directories, and adds its bundled Node directory. No shell output or shell credentials enter the renderer. Setup uses the daemon's guarded pinned-PATH refresh when a newly installed application is missing from its service environment. Windows reads the current machine and user PATH through the system PowerShell without loading a profile; its scheduled task reads those values on each native start. No renderer PATH is accepted. A shell that fails or a relative PATH refuses instead of guessing. Installation preserves the refusal message and next step before any service change.

On account-computer hosts, Open dashboard opens the signed-in provider's `/machines` page even before a space is launch-ready. Per-space hosts target `/machines?space=<canonical catalog id>&machine=<Manager instance id>` only with a launch-ready Manager. The canonical ID comes from the daemon's discovered catalog, not a space slug. Changing spaces or disconnecting discards the old per-space target.

The app does not replace existing daemon identities, change grants, or claim remote vitals that the registered service does not expose. Sign-out, identity-contract migration, remote management and signed automatic updates remain separate from these controls.

A dashboard can open `cotal://connect?idp=<encoded-provider-url>&space=<space>`. The installer registers this scheme. It only fills public provider/space fields; it does not start sign-in, approve a grant or connect. Unknown fields, secrets and duplicate parameters are refused. Development runs do not register a protocol handler on the host.

The equivalent terminal controls are `cotal daemon install`, `cotal daemon start`, `cotal daemon login --idp <url>`, `cotal daemon spaces --refresh`, and `cotal daemon setup --space <space> --idp <url>`. The app does not maintain a second configuration or login store. The lower-level `register` and `service-connect` adapter requests remain available for machine-service connections.

Registration requires the space owner's approval and the space operator's binding for `ai.cotal.machine`. No shipped command or page provides those approval controls. Once both are complete, rerun `cotal daemon register --space <space>` until it reports `registered`, then run `cotal daemon service-connect --space <space>`. See the [daemon registration prerequisites](../docs/cli-processes.mdx#daemon) for the approval states and refusals.

## Design

The cotal.ai site design system is the visual source: cream paper, navy ink, hard offset shadows and the three-ring mark. The app uses one paper theme in either OS appearance. Bricolage Grotesque, Geist and Geist Mono are bundled as latin WOFF2 files with their SIL Open Font License texts in `dist/licenses/`. No font host is contacted. The existing same-origin CSP covers fonts through `default-src 'self'`.

## Develop

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS and use Node 24 with the repository's pnpm version.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter cotal-ai seeded-connectors
pnpm --dir desktop prepare:runtime
pnpm --dir desktop check:runtime
pnpm --dir desktop app:dev
```

The runtime staging command uses lockfile-based `pnpm deploy` with a hoisted dependency layout to package the built stock workspace. It refuses an existing staged runtime rather than overwriting files a daemon could still be using. Use a clean build checkout for another version. No install or service start happens during staging.

On Windows, the bundled executable keeps the name `node.exe`. The runtime check relocates it with that installed name. Linux and macOS continue to use `cotal-node`. The app selects the bundled executable from its own installation, never from PATH.

```sh
pnpm --dir desktop test
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib
pnpm --dir desktop app:build
```

The Rust tests without default features check request, URL and environment boundaries, not the native webview or tray. A browser preview displays a native-controls-unavailable message rather than simulated daemon state.

`pnpm --dir desktop test:render` builds the real front end and serves it to headless Chromium with only the native bridge stubbed. Install its browser with `pnpm --dir desktop exec playwright-core install chromium`. The suite checks every state in both themes at 880×660 and 560×660: browser errors, page scroll, text clipping, target overlap, Tab order, axe accessibility including contrast, and reduced motion. Screenshots go to `desktop/test/render/artifacts/`, or `SHOTS=<directory>`. `CHROMIUM_PATH` selects an installed Chromium executable. `MOTION=1` also records 0, 80, 160 and 240 ms frames in normal and reduced motion, plus a JSON record of captured animations. Progress completion, success, notice expansion and Details opening must capture their expected finite animation. The server uses the app's shipped CSP. `CASES=<comma-separated-names>` narrows a local iteration. CI uploads the renders without comparing font-sensitive golden images.

The Desktop apps workflow has an optional `real_service` dispatch input. On disposable GitHub-hosted Linux, macOS and Windows runners it exercises the built CLI's install, local readiness, start without restart, and uninstall using a unique daemon home. macOS/Windows confirm native job absence through the CLI's install dry-run; Linux additionally reads systemd's explicit `not-found` state and verifies that the loaded unit supervises the answering PID. The endpoint must report `NOT_RUNNING` after removal. A session prerequisite refusal fails the run; it is not a passing skip. Failed or unknown cleanup is retained for runner disposal and recorded in the `daemon-service-*` artifact.

The Linux dispatch prepares only the disposable runner's user manager and enables linger before testing. It does not change a developer's user manager. This tests an already-lingering account, not unprivileged linger activation, logout survival or crash restart. No signed installer, browser sign-in or remote connection is exercised. The regular native-install smoke continues to use recording runners without installing a service.

## Platforms

| Platform | Desktop service | Installer |
|---|---|---|
| Linux | systemd user service | Debian and RPM |
| macOS | per-user LaunchAgent | app bundle and DMG |
| Windows | per-user Scheduled Task | NSIS and MSI |

The bundled Node 24 requires macOS 13.5 or later and Windows 10 / Server 2016 or later. Linux installers are built on Ubuntu 24.04 and require the platform WebKitGTK 4.1 libraries; older distributions have not been verified.

Native builds run on the target OS. AppImage is not a daemon distribution: its temporary mount is not a durable service executable path. Headless LaunchDaemon, Windows SCM and Linux system-service profiles are not provided by the desktop installer.

Validation builds are unsigned. Version-tag builds sign and notarize macOS packages when `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and one complete Apple ID or App Store Connect notarization set exist. Configuring both sets refuses the build. Windows uses `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` and `WINDOWS_TIMESTAMP_URL`, importing the owner's PFX and passing Tauri its thumbprint, SHA-256 and timestamp configuration. Missing platform secrets keep validation packaging unsigned; partial secrets or a signing failure stop the build. Linux signing is not configured. Version-tag installers are attached to the GitHub release, creating a draft if needed. No automatic-update feed is configured.

After replacing the app in the same installation directory, reopen it, choose a saved space and click Connect this computer. Read-only saved-space listing works across compatible daemon versions. Stock setup can restart the recorded owned service under its existing Manager seat fence to load the new bundled runtime. Other mismatched-version mutations remain refused. If the old service pins another installation directory or an incompatible protocol, setup refuses with its next step. That relocation needs the old installation's service removal before setup from the new app. Native installer replacement and active-seat acceptance still need testing on macOS and Windows.

## Local boundary

The OS user is the trust principal. A hostile process running as that same user is not isolated by the tray. Native peer authentication and lifetime custody protect the daemon from other users and foreign listeners. The renderer has no shell, filesystem or remote IPC capability. Rust launches only the bundled Node and stock CLI, admits a closed request schema, removes inherited provider/agent authority from its child environment, and bounds input/output and time. Browser opening permits HTTPS and literal loopback HTTP only. Login proofs and tokens never cross into the webview.

On macOS, starting or removing a loaded LaunchAgent requires its recorded source digest and native evidence matching its label, executable and full argument vector. New installs carry the working directory in those arguments: a small Node entry validates it and changes directory before loading the CLI. They do not depend on launchd exporting its WorkingDirectory property. Legacy plists that carry that property still require the matching native field; an omitted field refuses without stopping the job. No legacy receipt is migrated or adopted through the new path. An unavailable lookup or missing executable/arguments also refuses. `launchctl` display text is not parsed as authority.
