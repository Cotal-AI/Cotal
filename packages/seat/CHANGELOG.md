# @cotal-ai/seat

## 0.49.1

## 0.49.0

### Minor Changes

- b0aeca4: Make bare `cotal down` and `Manager.stop()` spare managed agents by default. Use
  `cotal down --with-agents` or `Manager.stop({ withAgents: true })` for deliberate destructive
  teardown. Linux PTY seats release manager-local proxy custody while their detached custodians and
  child processes continue running, and the CLI binds destructive intent to the exact live stop
  attempt so an interrupted command cannot poison a later bare shutdown. Managers launched before
  process identity pins existed remain stoppable after the documented reduced-guarantee warning:
  bare down cannot prove which SIGTERM handler that running binary carries, so it never reports the
  pre-signal seat inventory as confirmed spared. A genuinely older destructive handler may still reap
  those agents. `--with-agents` uses a one-shot handoff bound to the manager pid and the live
  stop-reservation inode, then signals unconditionally.
- cf6ced5: Make `cotal input` wait for the target runtime to acknowledge the PTY write before printing its byte receipt. Custodial and in-process PTY writes now return the accepted UTF-8 byte count or reject, and the manager refuses missing, partial, or failed acknowledgements with an error that names the seat. A dropped write therefore exits non-zero without a `sent` receipt instead of claiming delivery from the intended buffer.
- dd6fea0: The seat record pins the custodian's and the child's process start identity, and a new `reapSeat` signals only a process whose identity matches. It also pins the boot those pids belong to: a start token counts ticks since boot, so a record that outlived a reboot names pids that now belong to other processes, and such a record is refused rather than signalled. The manager records each seat's custody reference on its static slot and, when a successor terminalizes a crashed manager's lifecycle, reaps the orphaned seat process through the runtime's custody `reap` before retiring the lifecycle. A runtime without it refuses by name and the lifecycle stays held. The custody reference is reserved before the seat is launched and rides the slot's first durable row, so a manager that dies between the launch and the slot activation still leaves a seat its successor can address; `Runtime.spawn` takes that reserved reference and must honour it. The same reference rides the rollback object a failed spawn hands its `finally`, so a manager that launched a seat and then threw reaps it in-process instead of retiring the lifecycle and freeing the alias over a running seat. Every seat id is checked against the shape `seatId` mints before it is joined to the custody root, so a forged reference is refused rather than resolved to a path outside it.

  `reserve` and `reap` are NOT on the core `Runtime` contract. They live on a manager-local `CustodialRuntime` that the built-in pty runtime implements, because a backend that delegates to an external surface (`tmux`, `cmux`, `orca`, `herdr`) owns no process to signal and no custody record to pre-mint against, so the methods would have no meaning for it rather than merely no implementation. `adopt` stays on the generic contract.

  The two crash scenarios and the in-process rollback are three suites, `smoke:orphan-seat-reap`, `smoke:orphan-seat-spawn-window` and `smoke:orphan-seat-rollback`, because one command carrying them crossed the mutation-proof command timeout.

### Patch Changes

- 9a334ae: Honor connector-declared startup confirmation prompts in PTY seats by matching normalized terminal output, pressing Enter only when the prompt appears, and failing with a named bounded error when it does not.
- 5b2281c: Compile the seat JavaScript and type entrypoints during pack and publish after validating both native helpers. A new installed-distribution smoke packs the full CLI closure from an assembled seat tree and proves a fresh npm install imports seat, imports the manager, and prints the packaged CLI help banner.
- 3ad688e: Close the custodian Unix server, socket, durable record, and process after the PTY child exits and the last client disconnects.

## 0.48.2

## 0.48.1

## 0.48.0

## 0.47.1

### Patch Changes

- d633e2d: Republish `@cotal-ai/seat` with its compiled `dist/`.

  The 0.47.0 tarball was produced by the emergency bootstrap path before the workspace build had
  run, so it shipped `package.json`, the README, the licence and the two native helpers, and no
  `dist/`. Its export map targets `./dist/index.js`, so `@cotal-ai/manager` fails at load and the
  `cotal` binary does not start. npm does not allow replacing a published version, so the working
  distribution ships as a new one.

  This carries no source change. `ci:publish` builds the workspace before packing, so the
  republished tarball contains the declared entrypoints.

## 0.47.0

### Minor Changes

- e6d3c96: Split Linux PTY ownership out of the manager worker: a one-shot launcher starts one detached custodian process per seat, and `Runtime.adopt` returns a live proxy over a permissioned Unix socket. Off Linux, pty spawn stays in-process and `adopt` throws a named custody-transport error.
- 30cf300: Ship linux-x64 and linux-arm64 SO_PEERCRED helpers from native builder jobs, assembled before pack and publish. `waitForExit` drops the controller socket so a manager worker can exit after the child is gone.
- f43d842: Ship the Linux SO_PEERCRED helper as a prebuilt binary instead of compiling it on every customer install. Source builds compile against the Node headers next to the running binary, not a hardcoded `/usr/include/node`, and there is no `binding.gyp` for install to infer `node-gyp rebuild` from. Bound length-prefixed frames by claimed size at the header and by residual after draining complete frames, with an 8 MiB body cap so a 1000-row coloured snapshot still encodes.

### Patch Changes

- 4ea4257: Gate `@cotal-ai/seat` pack with `prepack` (not `prepare`) so a host-only tree cannot pack, and assert the native linux-x64/arm64 builder wiring in CI and Changesets from the workflow files.
- cf294e7: Settle pending wait-exit after a real child exit, drop the redundant handle catch, keep launch-failed when backlog throws on a closed attach stream, bound manager control-rail disconnects after a broker exit, refresh the bundled custody docs, and grade ci-ok as the sole always-running aggregate plus both pack polarities.
