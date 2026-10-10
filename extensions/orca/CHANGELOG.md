# @cotal-ai/orca

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.1

## 0.77.0

## 0.76.0

## 0.75.0

## 0.74.0

### Patch Changes

- 0534c53: The Orca runtime's read-only CLI calls (`status`, `worktree current`/`show`, `terminal list`/`show`/`read`) now give up after 2 seconds. They run synchronously on the manager's event loop, so an Orca app that was up but not answering blocked the whole manager, every seat's supervision included, for as long as it stalled: the manager's 5-second `status()` poll, the handle lookup before `stop`, `interrupt` and `attach`, the availability check and worktree resolution all waited on it with no limit. A status check that times out still reports the agent as running.

## 0.73.0

## 0.72.1

## 0.72.0

## 0.71.0

### Patch Changes

- 726a750: The tmux, cmux, Orca and Herdr runtimes now honour `LaunchSpec.confirm` as the PTY runtime does. Each reads its pane, presses Enter once when the declared prompt is on screen, and ends the seat with `Cotal startup confirmation failed: prompt "<prompt>" did not appear within 15000ms.` in the manager's log when it never appears. They used to press Enter five times on a one-second timer whatever the screen showed, so a dialog shown before the declared prompt was answered with its default. Core exports the shared `confirmWatch` they use.

  Each backend call the watch makes times out after one second: the screen read, the terminal lookup, the Enter, and the close that ends a failed seat. A call that times out is killed with SIGKILL, because Node waits for a timed-out child to exit and a CLI that handles SIGTERM would keep the manager blocked past the timeout. The status probes and other CLI calls that share those helpers are killed the same way when they time out. No read starts once the 15 seconds are up, so a backend CLI that hangs fails the seat instead of stalling the manager. The tmux watch ends a failed seat by closing the seat's pane in whichever window holds it now, so a pane swapped into the seat's first window survives. It reads, presses Enter and closes only on the tmux server that opened the seat's window, so after a tmux restart it never types into or closes a new pane that reuses the seat's pane id.

  A `confirm` prompt that is empty once ANSI codes and whitespace are removed, `""` included, is now refused before anything starts, and its launch files are removed. The PTY runtime used to start the child first and then throw, which left the child running with no handle to stop it and its launch files on disk, and every runtime treated `""` as no prompt.

## 0.70.2

## 0.70.1

## 0.70.0

## 0.69.0

## 0.68.0

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

## 0.58.0

## 0.57.0

## 0.56.1

## 0.56.0

## 0.55.0

## 0.54.0

## 0.53.0

## 0.52.1

## 0.52.0

## 0.51.0

## 0.50.1

## 0.50.0

## 0.49.0

## 0.48.2

## 0.48.1

## 0.48.0

## 0.47.1

## 0.47.0

## 0.46.0

### Minor Changes

- 9d745af: Add the local durable runtime adoption seam and report legacy manager continuity before a running update can be described as hot. `Runtime.adopt` is optional: runtimes without durable custody omit it, and the manager refuses by name rather than requiring a throwing stub on every adapter. `cotal update --self` reports the selected manager before a global install and hands `--space` / `--server` / `--creds` to the replacement child.

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.4

## 0.41.3

## 0.41.2

## 0.41.1

## 0.41.0

## 0.40.0

## 0.39.1

## 0.39.0

## 0.38.0

## 0.37.0

### Minor Changes

- 00ac9d9: manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.

### Patch Changes

- 31443f1: Make package-filtered test commands run counted assertions instead of succeeding without tests.

## 0.36.0

## 0.35.0

## 0.34.0

## 0.33.9

## 0.33.8

## 0.33.7

## 0.33.6

## 0.33.5

## 0.33.4

## 0.33.3

## 0.33.2

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.2

## 0.30.1

## 0.30.0

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.11

## 0.14.10

## 0.14.9

## 0.14.8

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

## 0.13.1

## 0.13.0

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

## 0.11.3

## 0.11.2

### Patch Changes

- 93fd521: Add the installable Orca runtime, registry-driven extension providers and local-process lifecycle,
  selective shutdown, and `cotal endpoints` for the complete live presence roster.
