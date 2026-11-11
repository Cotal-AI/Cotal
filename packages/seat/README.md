# @cotal-ai/seat

Local PTY seat custody: a one-shot launcher, one detached custodian process per seat, and the
authenticated local protocol a manager worker uses to adopt that handle.

**Tier:** `packages/` (leaf). Depends on PTY and terminal-mirror libraries, not on
`@cotal-ai/core`, workspace, implementations, connectors, or NATS. The manager's `pty` runtime
calls it only to adopt and reap seats an earlier manager left under a custodian.

Linux is the production transport in this cut. `create`/`spawn`/`adopt` in this package throw a
named `custody transport unsupported on <platform>` error on darwin and win32. There is no
in-process node-pty fallback here. The manager's `pty` runtime spawns in-process on every
platform. Its custodial `adopt` and `reap` are Linux-only and throw that named error elsewhere.

`peerCredentials(socket)` and its `PeerCredentials` type are exported from the package root.
For a connected Linux Unix socket, the function returns the kernel's peer `pid`, `uid` and
`gid` using the same `SO_PEERCRED` helper as custody. Callers must compare that identity
against their own authorization policy; a PID is not a lifecycle or ownership fence. It
throws for an unsupported transport or missing native helper, and for a socket without a
file descriptor. No PTY or custodian is started by reading the peer identity.

The same helper also carries the host primitives the local `cotal daemon` endpoint uses, which,
unlike custody, are built for Linux, macOS and Windows (`src/host.ts`): `localPeerCredentials`
(Linux `SO_PEERCRED`; macOS `LOCAL_PEERCRED`, the uid `getpeereid(3)` reads, with
`LOCAL_PEERPID`), `lockExclusiveNb` (`flock(2)`; on Windows `LockFileEx` on one byte past any
content), `processStartTime` (macOS and Windows), `darwinUserCacheDir`, `darwinLaunchdJob` (a
read-only `SMJobCopyDictionary` lookup of a loaded job, resolved at run time because Apple
deprecated it with no replacement and documents its contents as unstable), and on Windows
`windowsUserSid`, `windowsDirSecurity`, `listenPipe` and `connectPipe`. The pipe functions create,
connect and authenticate a named pipe in native code, because Node's own pipe server creates it
with a default DACL that admits Everyone and Anonymous for reading and accepts remote clients:
every instance gets a protected DACL granting only the user's SID, `FILE_FLAG_FIRST_PIPE_INSTANCE`
on the first and `PIPE_REJECT_REMOTE_CLIENTS` on all, and each side reads the other's process
token user and creation time before a connection is handed to Node as a descriptor.
`native/peercred_win32.c` documents each flag.

The custodian raises its child's `oom_score_adj` to 500 and writes one line to `custodian.log`
when the kernel refuses. The manager's in-process `pty` runtime applies the same preference
through the exported `preferSeatForOomKill`.

The Linux `SO_PEERCRED` helper is compiled for the host arch by `pnpm build`. That is a
developer tree, not a publishable one: it prints a host-dev-build banner and writes
`build/Release/linux-<arch>/peercred.node`. Pack and publish require both `linux-x64`
(ELF e_machine 62) and `linux-arm64` (ELF e_machine 183), copied in by
`scripts/seat-assemble-natives.mjs` from native builder jobs. `prepack` and
`prepublishOnly` assert both Linux helpers and the macOS and Windows helpers for x64 and arm64,
including their container format and architecture, then compile TypeScript without rebuilding them. The ARM load job installs the same packed tarball
with no rebuild. The compile uses the `include/node` directory next to the running
Node binary, not a hardcoded `/usr/include/node`. Off Linux `pnpm build` skips the compile, so
a macOS or Windows `pnpm build` does not need headers or a C compiler. `pnpm build:native`
compiles for the host on all three: macOS with `cc`, targeting macOS 11 like the workspace binding, into
`build/Release/darwin-<arch>/`, Windows with `cl.exe` from the MSVC Developer Command Prompt against
the Node headers and import library the workspace binding pins in `native/node-sdk.json`, into
`build/Release/win32-<arch>/`. Until a macOS or Windows helper is built or shipped, the host
primitives throw that it is missing. There is no `binding.gyp` in the package, so
`pnpm install` does not infer `node-gyp rebuild`. Customer `npm i` does not compile it. A host
without a C compiler installs the prebuilt helpers; a missing helper, an unsupported
`linux-<arch>`, or a load failure throws rather than compiling in place.

`pnpm smoke:seat-platform` runs its assembly and pack checks in a temporary package copy,
using header-only fixtures for all six native targets. It checks that refused and successful
packs leave the caller's compiled output and native helpers unchanged. These fixtures verify
package structure, not native loading, and never enter the caller's publish tree.

`pnpm smoke:seat-installed-dist` requires a built tree with the qualified seat and workspace
artifacts assembled by `scripts/seat-assemble-natives.mjs` and
`scripts/workspace-assemble-natives.mjs`, as the CI smoke job does. It runs both native guards
before packing. The fixture keeps the real binaries, compiles seat entrypoints from a copy without
`dist`, and stops if any local closure member fails to pack. The installed checks compare all native
binaries and workspace receipts with the assembled inputs and load the host seat binding.

The package.json has no `os` / `cpu` / libc fields. Manager depends on this package on every
platform: off Linux it still loads, and custody adoption, reaping and `cotal seats` throw the named
custody-transport error.
Gating install would skip the package on darwin and win32 and break that path. A musl or
non-Linux host that reaches `peerCredentials` throws; there is no compile fallback and no
silent degrade. First use of the helper is the right place for that refusal.

The launcher owns no PTY and exits after writing a permissioned per-seat record. Each custodian
owns exactly one `node-pty` object, its child relationship, its screen mirror, and exit
observation. A manager worker connects to that custodian over a 0600 filesystem Unix socket
authenticated by `SO_PEERCRED` uid match plus a per-seat capability token. Path possession is
not enough. Child exit is pushed to every authenticated controller socket. After the child
exits and the last authenticated client disconnects, the custodian closes the Unix server, unlinks the
socket, and exits. The custody record stays until `reapSeat` verifies process departure. If the
recorded group leader is absent but its numeric process group still has members, ownership is
unproved: reaping refuses without signalling those members or deleting the record. An active child, or a still-connected observer of an exited
child, keeps the process. A connected socket that never authenticated does not: it owns no
session, no output subscription and no wait, so a settle owes it nothing. A seat whose child has
already exited at listen stays up briefly so the launcher can adopt it.

A reap signals the custodian and the child only while each carries its recorded start identity.
The child's descendants are not in the record, so the reap kills the child's process group by
membership. The record carries no authentication, so a same-uid process that rewrites it chooses
what the next reap signals. `docs/security-boundaries.mdx` lists both as accepted residuals.

A custodian with no authenticated controller stops its child and exits after `UNATTENDED_MS`
(ten minutes, overridable at launch with `COTAL_SEAT_UNATTENDED_MS`). The window restarts at each
disconnect, so a manager that detaches and re-adopts keeps its seats; one that crashes, or a suite
that returns without reaping, no longer leaves a custodian holding memory for a controller that
will never come back. The bound is resolved by the launcher and carried in the launch payload,
because the custodian's own environment is scrubbed.

Every custodian carries `--cotal-run <marker>` on its argv and `COTAL_RUN` in its environment.
`COTAL_RUN` names the run when a caller sets one, otherwise the launching pid does.
`censusCustodians(run?)` reads that marker back out of `/proc/<pid>/cmdline`, which is
world-readable, so a reaper can find and attribute orphans without walking `/proc/*/cwd`.

`drainSeats(root, { drain })` lists the custody records under a root. A record that cannot be
read, or whose start and boot identity do not tie its pids to this boot, is reported as `refused`
and left on disk, with or without `drain`. On a host that publishes no boot identity, no record
can be tied to this boot, so every one is refused. A seat whose child still holds its recorded start
identity is reported as `live-child` and never signalled. With `drain`, every other seat goes
through `reapSeat`. One it cannot prove gone is reported as `refused` and left on disk, and
`reapSeat` may already have sent `SIGKILL` to its custodian.
`cotal manager seats [--drain]` (also spelled `cotal seats`) is the operator command over it.

Generation CAS, the crash journal, N/N-1 protocol compatibility, and manager-worker activation
are later milestones. This package currently speaks a single implicit controller.
