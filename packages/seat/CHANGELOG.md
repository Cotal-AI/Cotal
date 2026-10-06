# @cotal-ai/seat

## 0.69.0

## 0.68.0

### Patch Changes

- 2638235: A static retirement interrupted after its lifecycle audit was written now completes when a later manager process retries it. The retry compared the stored audit against its own manager process uid and broker eviction counts, so every process after the first, and any retry that found the connections already kicked, failed with `records different evidence` and left the slot `terminalizing`. The comparison now keys on the stable retirement identity: the principal, alias, lifecycle uid, manager instance and retirement op. The pty reaper also treats a custody record from an earlier boot as a seat that is gone. It used to refuse such a record, which held the name after a reboot on every attempt; it now removes the record without signalling anything, since no process outlives a reboot, and `cotal seats` reports it as `childless`.

## 0.67.0

## 0.66.1

## 0.66.0

## 0.65.0

## 0.64.0

## 0.63.0

## 0.62.0

## 0.61.0

## 0.60.0

## 0.59.0

### Patch Changes

- 5f13124: Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once it has proved the agent process gone. On the default pty runtime the manager removes them when it sees the agent exit; on tmux, cmux, orca and herdr the manager removes them by polling the seat's status and waiting for the runtime's exit proof; the foreground `cotal spawn` removes them when its child exits. Every one of those launches also starts its child through the new core `reclaimWithChild`: a watcher started beside the child removes the files once the child's process is gone, and tries a failed removal again every five seconds until it succeeds, so a killed manager or foreground `cotal spawn` no longer strands them (POSIX; Windows has no shell for the watcher). Each directory name carries a random per-launch identity, so a stale path can never name a later launch's directory. The tmux, cmux, orca and herdr runtimes now throw the new core `SpawnRefused` for an unsafe name, an unreachable backend, (herdr) a missing working directory or an unknown layout, (orca) a working directory that is missing or outside any Orca worktree, and a launcher script they cannot write or (tmux, herdr) a session or server that will not start, all before the agent's command is handed to the backend, and the manager removes the files at once. A removal that fails, after an exit or after a refusal, is tried again until it succeeds. A batch resume removes the files of specs it built and never launched. Both connectors now refuse a bad model, prompt or launch option before writing anything. Any other spawn that throws is not proof that nothing started, so its files stay for the child's watcher, or for the OS temp reaper when no child started, as do a killed launcher's on Windows. A seat started under a custodian with `launchSeat` from `@cotal-ai/seat`, which the manager no longer does for a new launch, hands them to that custodian: a launch it refuses before any process started removes them at once, the custodian removes them when it sees the agent exit, a removal that fails stays on the custody record, and a reap that proves the seat gone removes what the record still lists from the temp dir the launch wrote to, so a successor with a different `TMPDIR` still removes them. Losing a custodian's connection no longer counts as the agent's exit. The docs now say that owner-private means any process running as the same user can read the file while it exists.
- 61d6365: Stop starting a detached seat custodian for every default `pty` spawn on Linux. The built-in `pty` runtime now spawns in-process on every platform, the same as macOS and Windows, and reports `legacy` custody. On Linux it still adopts and reaps seats that an earlier manager left under a custodian, so existing seats drain under the new manager. Because the pty runtime can no longer spare its seats, a bare `cotal down` on Linux now asks for `cotal down --with-agents` while pty agents are running, as it already did on other platforms. The in-process pty runtime gives no hot-update guarantee. `cotal seats` lists the custody records an earlier Linux manager left, and `cotal seats --drain` retires each seat whose agent has exited. A seat whose agent still runs is never signalled, and a record that cannot be proved safe is refused and kept. A record with no start or boot identity, or one from an earlier boot, is refused by the read-only listing too, rather than reported as running or exited. The seat package exports the same inventory as `drainSeats`.
- 8d8d69a: A pty seat whose process exits on its own is logged as `seat reaped: ... exit code <n>[, signal <s>]` followed by the last line the child printed that starts with a connector's `[cotal-<name>]` or `[cotal-<name>/<part>]` prefix, cut to 240 characters, such as `[cotal-jcode] AG-UI emitter stopped: ...` or `[cotal-hermes/bridge] ...`. This holds for a seat the manager spawned in-process and for one a seat custodian holds. The custodian now sends the child's exit code, signal and that diagnostic with its exit event, and the seat handle reports them through `exitInfo()`, so a custodial seat no longer reads `exit detail unavailable from runtime "pty"`. `@cotal-ai/seat` exports the shared `ConnectorDiagnosticReader`. The custodian writes the same record beside the custody record, so a reap of the seat by reference reports how the child ended. When that record cannot be written, the custodian logs why, and the reap of a child that ended on its own says the record is missing or unreadable.
- 62b004b: Record the two accepted residuals of the seat reap in the security model. The reap kills the seat child's process group by membership with no per-member start identity check, and it trusts the pids and start tokens its custody record names, so a same-uid process that rewrites `record.json` chooses what the next reap signals. The `reapSeat` doc comment and the design note on signer isolation no longer claim that the reap signals only identity-matched pids.

## 0.58.0

### Patch Changes

- 5831ef8: Pty seats are marked more killable than the broker (`oom_score_adj` 500 on the seat's PTY child), with a logged reason when the kernel refuses and an explicit unavailable line off Linux.
- 66ef843: Export the existing Linux socket peer-credentials reader and its type from the seat package root so embedders can apply their own UID policy without importing private native-helper paths. Verify the public API with real separate-process Unix sockets and explicit unsupported-platform refusal.
- a726a3d: Register the hosted service and renewal checks with stable CI suite fragments, mark the restart fixture's broker for owned teardown, and verify unsupported seat reaping on other platforms without claiming Linux process-group coverage. Let the continuity fixture observe an already-started transport reconnect before preparing its recovery command.
- fd0cf70: Retain custody records on disk across seat exit until verified reaping confirms kernel process identities and purges the directory, enabling manager process restart reconciliation. Refuse reaping when a dead leader leaves a nonempty group whose generation cannot be proved, retaining the custody record without signalling that group.

## 0.57.0

## 0.56.1

## 0.56.0

## 0.55.0

## 0.54.0

### Minor Changes

- 34beea1: Route user-auth manager calls through a short-lived, instance-bound control credential. Discovery and invocation address the same authorized manager while the agent's standing connection, credentials and conversation remain unchanged. Managed launches retain their manager selection across launch and resume. Static and open mesh routing is unchanged. Confirm the standing goal-progress subscription at the broker before submitting on the separate control connection, so fast terminal events cannot outrun the subscription. Recover accepted goal results through the manager's caller-scoped `goal-result` command after connection replacement, without repeating the mutation or granting clients raw JetStream reads. Followed calls now require a compatible manager before submission; update the issuer, participant manager and client together. Stopping a caller cancels its observation without cancelling the accepted goal. Retain Linux custody records across clean child exit so retirement can prove process identity and finish cleanup even after the custodian removes its file; socket loss alone never frees the alias.

## 0.53.0

## 0.52.1

## 0.52.0

## 0.51.0

## 0.50.1

## 0.50.0

### Minor Changes

- e72dd07: Bound the life of an unattended seat custodian, and make a census of them cheap.

  A custodian whose manager crashed or whose suite returned without reaping it waited forever for a
  controller that no longer existed, holding roughly 65 MB each. A full smoke shard left about
  eighteen behind per run, and they accumulated across runs until the host was under memory pressure.
  They were also hard to find: the only thing tying one to its worktree was its cwd, so a census had
  to walk `/proc/*/cwd`, which needs the owner's uid for every pid it inspects.

  A custodian with no authenticated controller now stops its child and exits after `UNATTENDED_MS`
  (ten minutes; `COTAL_SEAT_UNATTENDED_MS` overrides it at launch, and a malformed or non-positive
  value throws rather than restoring the default). The window restarts at each disconnect, so a
  manager that detaches and re-adopts keeps its seats.

  Every custodian now carries `--cotal-run <marker>` on its argv and `COTAL_RUN` in its environment,
  and `censusCustodians(run?)` reads that marker back out of `/proc/<pid>/cmdline`. The smoke shard
  runner names each run and kills the custodians carrying that marker after every suite, failing the
  shard for a suite that passed but leaked one, and leaving other runs' custodians alone.

  The transport also refuses a socket path the kernel would truncate. `sun_path` holds 108 bytes
  including its NUL; past that libuv copies into the fixed buffer, truncates, and `listen` succeeds on
  the shortened name, so the custodian cleaned up a socket it never created and died without writing
  its log. `launchSeat` now refuses an oversized path by name, the custodian verifies the path it
  bound and logs any startup failure instead of dying uncaught, and `@cotal-ai/smoke-kit` gains
  `makeSeatRoot` so a suite's custody root stays short whatever `TMPDIR` says.

  `runMarker` recovers `COTAL_RUN` from the nearest ancestor that still carries it, so a suite that
  scrubs `COTAL_` from a child environment does not make its custodians unattributable.

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
