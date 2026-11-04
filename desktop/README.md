# Cotal desktop

The Tauri app controls the stock `cotal daemon`. It bundles that CLI and Node 24, so end users do not need a terminal, Node or npm. The app and CLI use the same daemon, sign-in and space registry. Closing the window hides it in the tray; quitting the app leaves the installed daemon running.

## Use

Open Cotal, set up its background service, and sign in through your provider's browser approval page. The daemon receives and stores the login session. Choose a discovered space and request its owner's approval, then connect. Local readiness and pending approval are not shown as a connected machine. Disconnect closes the selected connection; it does not revoke remote grants.

The app grants no remote execution or file access. It does not replace existing daemon identities, change grants, or claim remote vitals that the registered service does not expose. Sign-out, identity-contract migration, remote management and signed automatic updates remain separate from the connection controls implemented here.

A dashboard can open `cotal://connect?idp=<encoded-provider-url>&space=<space>`. The installer registers this scheme. It only fills public provider/space fields; it does not start sign-in, approve a grant or connect. Unknown fields, secrets and duplicate parameters are refused. Development runs do not register a protocol handler on the host.

The equivalent terminal controls are `cotal daemon install`, `cotal daemon start`, `cotal daemon login --idp <url>`, `cotal daemon spaces --refresh`, and `cotal daemon service-connect --space <space>`. The app does not maintain a second configuration or login store.

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

```sh
pnpm --dir desktop test
pnpm --dir desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib
pnpm --dir desktop app:build
```

The Rust tests without default features check request, URL and environment boundaries, not the native webview or tray. A browser preview displays a native-controls-unavailable message rather than simulated daemon state.

## Platforms

| Platform | Desktop service | Installer |
|---|---|---|
| Linux | systemd user service | Debian and RPM |
| macOS | per-user LaunchAgent | app bundle and DMG |
| Windows | per-user Scheduled Task | NSIS and MSI |

The bundled Node 24 requires macOS 13.5 or later and Windows 10 / Server 2016 or later. Linux installers are built on Ubuntu 24.04 and require the platform WebKitGTK 4.1 libraries; older distributions have not been verified.

Native builds run on the target OS. AppImage is not a daemon distribution: its temporary mount is not a durable service executable path. Headless LaunchDaemon, Windows SCM and Linux system-service profiles are not provided by the desktop installer.

Build artifacts are not signed production releases. macOS distribution needs Developer ID signing and notarization; Windows distribution needs the owner's signing configuration; Linux release channels need their package/repository signing setup. No unsigned automatic-update feed is configured. Bundled runtime versions are pinned together, and the app refuses daemon mutations when the running daemon reports another version.

## Local boundary

The OS user is the trust principal. A hostile process running as that same user is not isolated by the tray. Native peer authentication and lifetime custody protect the daemon from other users and foreign listeners. The renderer has no shell, filesystem or remote IPC capability. Rust launches only the bundled Node and stock CLI, admits a closed request schema, removes inherited provider/agent authority from its child environment, and bounds input/output and time. Browser opening permits HTTPS and literal loopback HTTP only. Login proofs and tokens never cross into the webview.

On macOS, starting or removing a loaded LaunchAgent also requires native evidence that its label, executable, arguments and working directory match the recorded definition. If macOS omits a required field or the lookup is unavailable, the operation refuses without stopping the job. `launchctl` display text is not parsed as authority.
