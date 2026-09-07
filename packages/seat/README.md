# @cotal-ai/seat

Local PTY seat custody: a one-shot launcher, one detached custodian process per seat, and the
authenticated local protocol a manager worker uses to adopt that handle.

**Tier:** `packages/` (leaf). Depends on PTY and terminal-mirror libraries, not on
`@cotal-ai/core`, workspace, implementations, connectors, or NATS. The manager's `pty` runtime
is the first production caller.

Linux is the production transport in this cut. `create`/`spawn`/`adopt` in this package throw a
named `custody transport unsupported on <platform>` error on darwin and win32. There is no
in-process node-pty fallback here. The manager's `pty` runtime still spawns in-process off
Linux and only `adopt` throws that named error.

The Linux `SO_PEERCRED` helper is compiled for the host arch by `pnpm build`. That is a
developer tree, not a publishable one: it prints a host-dev-build banner and writes
`build/Release/linux-<arch>/peercred.node`. Pack and publish require both `linux-x64`
(ELF e_machine 62) and `linux-arm64` (ELF e_machine 183), copied in by
`scripts/seat-assemble-natives.mjs` from native builder jobs. `prepack` asserts
those two files and does not compile. `prepublishOnly` runs the same assert on
publish. The ARM load job installs the same packed tarball
with no rebuild. The compile uses the `include/node` directory next to the running
Node binary, not a hardcoded `/usr/include/node`. Off Linux the compile script is a no-op, so
Windows `pnpm build` does not need headers or a C compiler. There is no `binding.gyp`, so
`pnpm install` does not infer `node-gyp rebuild`. Customer `npm i` does not compile it. A host
without a C compiler installs the prebuilt helpers; a missing helper, an unsupported
`linux-<arch>`, or a load failure throws rather than compiling in place.

The package.json has no `os` / `cpu` / libc fields. Manager depends on this package on every
platform: off Linux it still loads, and only `adopt` throws the named custody-transport error.
Gating install would skip the package on darwin and win32 and break that path. A musl or
non-Linux host that reaches `peerCredentials` throws; there is no compile fallback and no
silent degrade. First use of the helper is the right place for that refusal.

The launcher owns no PTY and exits after writing a permissioned per-seat record. Each custodian
owns exactly one `node-pty` object, its child relationship, its screen mirror, and exit
observation. A manager worker connects to that custodian over a 0600 filesystem Unix socket
authenticated by `SO_PEERCRED` uid match plus a per-seat capability token. Path possession is
not enough. Child exit is pushed to every authenticated controller socket.

Generation CAS, the crash journal, N/N-1 protocol compatibility, and manager-worker activation
are later milestones. This package currently speaks a single implicit controller.
