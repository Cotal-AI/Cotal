# @cotal-ai/seat

## 0.47.0

### Minor Changes

- e6d3c96: Split Linux PTY ownership out of the manager worker: a one-shot launcher starts one detached custodian process per seat, and `Runtime.adopt` returns a live proxy over a permissioned Unix socket. Off Linux, pty spawn stays in-process and `adopt` throws a named custody-transport error.
- 30cf300: Ship linux-x64 and linux-arm64 SO_PEERCRED helpers from native builder jobs, assembled before pack and publish. `waitForExit` drops the controller socket so a manager worker can exit after the child is gone.
- f43d842: Ship the Linux SO_PEERCRED helper as a prebuilt binary instead of compiling it on every customer install. Source builds compile against the Node headers next to the running binary, not a hardcoded `/usr/include/node`, and there is no `binding.gyp` for install to infer `node-gyp rebuild` from. Bound length-prefixed frames by claimed size at the header and by residual after draining complete frames, with an 8 MiB body cap so a 1000-row coloured snapshot still encodes.

### Patch Changes

- 4ea4257: Gate `@cotal-ai/seat` pack with `prepack` (not `prepare`) so a host-only tree cannot pack, and assert the native linux-x64/arm64 builder wiring in CI and Changesets from the workflow files.
- cf294e7: Settle pending wait-exit after a real child exit, drop the redundant handle catch, keep launch-failed when backlog throws on a closed attach stream, bound manager control-rail disconnects after a broker exit, refresh the bundled custody docs, and grade ci-ok as the sole always-running aggregate plus both pack polarities.
