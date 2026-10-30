# @cotal-ai/herdr

## 0.130.0

No changes in this release.

## 0.129.9

No changes in this release.

## 0.129.8

No changes in this release.

## 0.129.7

No changes in this release.

## 0.129.6

No changes in this release.

## 0.129.5

No changes in this release.

## 0.129.4

No changes in this release.

## 0.129.3

No changes in this release.

## 0.129.2

No changes in this release.

## 0.129.1

No changes in this release.

## 0.129.0

No changes in this release.

## 0.128.7

No changes in this release.

## 0.128.6

No changes in this release.

## 0.128.5

No changes in this release.

## 0.128.4

No changes in this release.

## 0.128.3

No changes in this release.

## 0.128.2

No changes in this release.

## 0.128.1

No changes in this release.

## 0.128.0

No changes in this release.

## 0.127.5

No changes in this release.

## 0.127.4

No changes in this release.

## 0.127.3

No changes in this release.

## 0.127.2

No changes in this release.

## 0.127.1

No changes in this release.

## 0.127.0

No changes in this release.

## 0.126.3

No changes in this release.

## 0.126.2

No changes in this release.

## 0.126.1

No changes in this release.

## 0.126.0

No changes in this release.

## 0.125.0

No changes in this release.

## 0.124.3

No changes in this release.

## 0.124.2

No changes in this release.

## 0.124.1

No changes in this release.

## 0.124.0

No changes in this release.

## 0.123.0

No changes in this release.

## 0.122.0

No changes in this release.

## 0.121.7

No changes in this release.

## 0.121.6

No changes in this release.

## 0.121.5

No changes in this release.

## 0.121.4

No changes in this release.

## 0.121.3

### Patch Changes

- fe38cbd: `@cotal-ai/core` now exports `launcherSource` (and `LauncherPayload`) to build the private Node launcher script that `@cotal-ai/orca` and `@cotal-ai/herdr` write through `writeSecretFile`, parameterized by the diagnostic label and launch payload, while each runtime keeps its own temporary-directory prefix and backend transport.

## 0.121.2

No changes in this release.

## 0.121.1

No changes in this release.

## 0.121.0

No changes in this release.

## 0.120.2

No changes in this release.

## 0.120.1

No changes in this release.

## 0.120.0

No changes in this release.

## 0.119.5

No changes in this release.

## 0.119.4

No changes in this release.

## 0.119.3

No changes in this release.

## 0.119.2

No changes in this release.

## 0.119.1

No changes in this release.

## 0.119.0

No changes in this release.

## 0.118.3

No changes in this release.

## 0.118.2

No changes in this release.

## 0.118.1

No changes in this release.

## 0.118.0

No changes in this release.

## 0.117.1

No changes in this release.

## 0.117.0

No changes in this release.

## 0.116.5

No changes in this release.

## 0.116.4

No changes in this release.

## 0.116.3

No changes in this release.

## 0.116.2

No changes in this release.

## 0.116.1

No changes in this release.

## 0.116.0

No changes in this release.

## 0.115.4

No changes in this release.

## 0.115.3

No changes in this release.

## 0.115.2

No changes in this release.

## 0.115.1

No changes in this release.

## 0.115.0

No changes in this release.

## 0.114.1

No changes in this release.

## 0.114.0

No changes in this release.

## 0.113.3

No changes in this release.

## 0.113.2

No changes in this release.

## 0.113.1

No changes in this release.

## 0.113.0

No changes in this release.

## 0.112.0

No changes in this release.

## 0.111.1

No changes in this release.

## 0.111.0

No changes in this release.

## 0.110.0

No changes in this release.

## 0.109.25

No changes in this release.

## 0.109.24

No changes in this release.

## 0.109.23

No changes in this release.

## 0.109.22

No changes in this release.

## 0.109.21

No changes in this release.

## 0.109.20

No changes in this release.

## 0.109.19

No changes in this release.

## 0.109.18

No changes in this release.

## 0.109.17

No changes in this release.

## 0.109.16

No changes in this release.

## 0.109.15

No changes in this release.

## 0.109.14

### Patch Changes

- 60e6671: A managed Claude Code seat that stops on Claude's first-run text style picker, its login method choice or its Bypass Permissions warning now fails at the startup bound naming that screen and the step that clears it. It used to fail saying the development-channels prompt did not appear, which pointed at the wrong cause. Cotal still never answers any of these screens: the Bypass Permissions warning stays for the user to accept once, or the launch passes `--opt permission-mode=default` (`launchOptions: {permission-mode: default}` in a manifest). A launch recipe declares such screens in the new optional `LaunchSpec.confirmBlockers`. The pty, custody, tmux, cmux, Orca and Herdr runtimes send no key while one is on screen and name its reason when the bound ends there. A runtime that ignores the field fails as before, with the generic message.
  
  A foreground `cotal spawn` of Claude Code no longer passes `--permission-mode bypassPermissions`. It runs in your terminal, so Claude keeps its own permission mode and you answer its prompts there; before, it opened on the Bypass Permissions warning while the spawn's hint said to press Enter at the development-channels prompt, and Enter there exits Claude. A managed seat keeps bypass as its default, and a permission option you pass still wins in both.
  
  `cotal up -f` no longer prints a success mark for its agents. It says the stack is up and the agents' launch is pending, that it does not wait for them to join, and names `cotal ps --space <space>` and the manager's log, where a failed launch is recorded with its reason.
  
  The quickstart and the team guide now say to finish Claude's first run once before the manager launches Claude Code, and give both permission routes.

## 0.109.13

No changes in this release.

## 0.109.12

No changes in this release.

## 0.109.11

No changes in this release.

## 0.109.10

No changes in this release.

## 0.109.9

No changes in this release.

## 0.109.8

No changes in this release.

## 0.109.7

No changes in this release.

## 0.109.6

No changes in this release.

## 0.109.5

No changes in this release.

## 0.109.4

No changes in this release.

## 0.109.3

No changes in this release.

## 0.109.2

No changes in this release.

## 0.109.1

No changes in this release.

## 0.109.0

No changes in this release.

## 0.108.1

No changes in this release.

## 0.108.0

No changes in this release.

## 0.107.0

No changes in this release.

## 0.106.1

No changes in this release.

## 0.106.0

No changes in this release.

## 0.105.1

No changes in this release.

## 0.105.0

No changes in this release.

## 0.104.2

No changes in this release.

## 0.104.1

No changes in this release.

## 0.104.0

### Minor Changes

- b7d4f22: A foreground `cotal spawn` on a manager whose runtime streams no terminal now launches the agent
  and stops there, instead of launching it and then failing `OPERATION_PARTIAL` on an attach that
  runtime cannot open. Only the built-in `pty` runtime streams a terminal; `tmux`, `cmux`, `orca` and
  `herdr` start the agent in a surface the manager does not own. A launch on one of those exits 0
  with the agent running, and its receipt names the runtime, says the seat runs in the manager's own
  session, and gives `cotal watch` and `cotal send` as the way to reach it. `--json` carries the same
  answer as `result.streamsTerminal`. A `pty` manager still attaches.
  
  `cotal attach <name>` on such a seat is refused once as `UNSUPPORTED`, carrying that runtime's own
  guidance for watching the agent where it runs, and the reconnect loop no longer retries it. The
  manager question's rows name each manager's runtime and whether a terminal attaches to its seats,
  so the choice is informed before a launch.
  
  Breaking for anyone who implements the `Runtime` contract outside this repo: `streamsTerminal` is a
  required field, and a backend that streams no terminal must say so rather than leave a caller to
  find out by catching the throw from `attach()`. The manager reports it to its callers on the launch
  reply and in its presence card, and a manager that does not report it is attached to as before.

### Patch Changes

- e0c4e6e: Correct the documentation page by page against the implementation, including CLI commands, connector delivery and activity sharing, authentication, observer surfaces, hosted composition, telemetry and historical design status. Refresh package guides and generated tool and HTTP references while preserving existing links and normative contracts.

## 0.103.4

No changes in this release.

## 0.103.3

No changes in this release.

## 0.103.2

No changes in this release.

## 0.103.1

No changes in this release.

## 0.103.0

No changes in this release.

## 0.102.0

No changes in this release.

## 0.101.7

No changes in this release.

## 0.101.6

No changes in this release.

## 0.101.5

No changes in this release.

## 0.101.4

No changes in this release.

## 0.101.3

No changes in this release.

## 0.101.2

No changes in this release.

## 0.101.1

No changes in this release.

## 0.101.0

No changes in this release.

## 0.100.2

No changes in this release.

## 0.100.1

No changes in this release.

## 0.100.0

No changes in this release.

## 0.99.3

No changes in this release.

## 0.99.2

No changes in this release.

## 0.99.1

No changes in this release.

## 0.99.0

No changes in this release.

## 0.98.0

No changes in this release.

## 0.97.1

No changes in this release.

## 0.97.0

No changes in this release.

## 0.96.1

No changes in this release.

## 0.96.0

No changes in this release.

## 0.95.2

No changes in this release.

## 0.95.1

No changes in this release.

## 0.95.0

No changes in this release.

## 0.94.7

No changes in this release.

## 0.94.6

No changes in this release.

## 0.94.5

No changes in this release.

## 0.94.4

No changes in this release.

## 0.94.3

No changes in this release.

## 0.94.2

No changes in this release.

## 0.94.1

No changes in this release.

## 0.94.0

No changes in this release.

## 0.93.0

No changes in this release.

## 0.92.2

No changes in this release.

## 0.92.1

No changes in this release.

## 0.92.0

## 0.91.0

## 0.90.1

## 0.90.0

## 0.89.0

## 0.88.0

## 0.87.0

## 0.86.0

## 0.85.0

### Patch Changes

- 6e10d50: A detached Claude Code spawn no longer fails its startup confirmation when Claude skips the development-channels warning and opens its input screen. Claude 2.1.301 does that when channels are off for the session, for example under a Team or Enterprise organization that has not set `channelsEnabled: true` in managed settings. Such a seat now stays up, and gets mesh messages through its hooks only, so a message does not wake it while it is idle. When the warning appears it is still answered with one Enter, and an unknown startup dialog still gets no key and fails within 15 seconds. A launch recipe can now declare `LaunchSpec.confirmReady`, texts that show the harness reached its input screen. Seeing one on two screen reads in a row ends the startup watch with no key. The PTY, tmux, cmux, Orca and Herdr runtimes honour it; a custom runtime that ignores it keeps failing such a launch as before.

## 0.84.0

## 0.83.0

## 0.82.2

## 0.82.1

## 0.82.0

## 0.81.1

## 0.81.0

## 0.80.0

### Minor Changes

- 5417401: Authorized managed Claude launches now accept the selected workspace through the native trust dialog. Startup choices are matched against the current screen and answered once before the existing development-channel confirmation. Foreground trust prompts are unchanged. No tool-permission bypass flag is added; accepting trust enables the checkout's own hooks and settings. Upgrade the connector, core and runtime together; older runtimes do not implement the new startup choices.

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.1

## 0.77.0

## 0.76.0

## 0.75.0

## 0.74.0

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

### Minor Changes

- b519e73: Add the Herdr integration: a new `@cotal-ai/herdr` extension with a self-registering `herdr` Runtime provider that spawns managed agents into panes of a dedicated named Herdr session (`cotal-<space>`), where the Herdr server owns them — so they survive the manager's terminal going away. Requires herdr >= 0.8.0, enforced by a version check rather than a bare binary probe, so an older herdr reports the runtime as unavailable instead of advertising it and then failing every spawn.

  Each agent gets its own workspace and name-labeled tab by default (`COTAL_HERDR_LAYOUT=split` folds them into one shared tab). A spawn is `workspace create` + `pane run "exec …"`, then a bounded wait on the real process table — `pane run` types into a shell, so a delivered keystroke is not proof that anything started. The `exec` is load-bearing: without it the pane's shell outlives the agent and no exit could be proven. Lifecycle is keyed by Herdr's stable `terminal_id` with the public pane id re-resolved per operation off the session-wide pane inventory; creds ride an owner-only launcher script, never herdr's command line or its native `--env` (which lands in pane scrollback); every CLI call is scoped with `--session`.

  Spawned agents do not appear in Herdr's Agents sidebar: 0.8.0 reserves that registry for recognized agent kinds attached to an existing pane, so an arbitrary launcher is never one. They are identified by tab label and a `cotal` metadata token on the pane.

  The CLI lists `herdr` among the official runtimes (`cotal runtimes`, `cotal ext add @cotal-ai/herdr`), and CI now installs herdr so the extension's smoke suite actually gates rather than silently skipping.
