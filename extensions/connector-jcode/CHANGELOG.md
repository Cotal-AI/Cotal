# @cotal-ai/connector-jcode

## 0.41.3

## 0.41.2

## 0.41.1

## 0.41.0

## 0.40.0

### Minor Changes

- 005aa61: connector-jcode: keep a seat name launchable after the seat is stopped or reaped.

  The short socket alias at `/tmp/jc-<hash>/home` is derived from the seat home, so one seat name
  reuses one path for the life of the machine. A launch handed that path back on teardown while a
  Jcode server the dead lifecycle left running was still using it as its `JCODE_HOME`, that server
  re-created the path as a real directory, and refusing a non-symlink there retired the name for
  good: every later launch of it failed before Jcode started, reporting `(unknown)` and pointing at a
  private log the failure had never reached.

  The alias is now reclaimed rather than refused. Each launch also records its identity nonce and its
  host process in the private home, and the seat's next launch stops the Jcode tree that record names
  once the recorded host is provably gone, so a lifecycle killed without its teardown no longer holds
  the seat's runtime directory for five minutes. A tree whose connector is still alive is left to
  Jcode's own runtime-directory lock. Failures preparing that private state now report a
  `private_state` code instead of `unknown`.

## 0.39.1

## 0.39.0

### Minor Changes

- 34ff272: `cotal run`, the workflow-run operator surface, self-registered by `@cotal-ai/runtime` and composed
  into the `cotal` binary: `start --file <program>` drives a new run on the mesh handler, `resume
<runId> --file <program>` takes an existing run over and drives it to quiescence, `ps` lists an
  endpoint's run records (state, holder, journal high-water, fork lineage), `journal <runId>` prints
  the durable step journal, and `answer <runId> <stepKey> --by <who> [--value <json>]` resolves an
  open checkpoint through the run driver, presenting as the arming holder read back from the
  checkpoint record (resume is holder-bound). One raw connection per invocation against the resolved
  mesh target; the journal's result bound is taken from the broker's own max_payload.

  `docs/workflows.md` gains an "Operating a run" section, the connector docs bundle carries it, and
  every connector folds a workflow steer (`WORKFLOW_STEER`) into its agent instructions beside the
  mesh-first steer, so agents reach for a durable journalled run instead of improvising long
  coordination loops in their own context.

## 0.38.0

### Minor Changes

- 1a330c7: Managed Jcode seats launch on macOS and the BSDs again. Credential mirroring pins each parent
  directory so an ancestor swapped mid-walk cannot redirect a copy, mkdir, or unlink outside the
  private home, and the only pin the connector had was `/dev/fd/<fd>/<name>`, which needs Linux
  procfs traversal, so #1170 bounded managed seats to Linux to keep that guarantee.

  The pin now has a second mechanism with the same contract. macOS and the BSDs pin the parent as the
  process working directory: after `chdir`, a single-component name resolves from that directory's
  inode and no ancestor is walked again, which is the same guarantee `/dev/fd/<fd>/<name>` provides on
  Linux. `chdir` takes a path, so entry is verified rather than trusted: the entered directory's
  inode must equal the inode of the descriptor opened a moment before, which closes the window between
  the two. The previous working directory is restored on every exit, including the refusing ones.

  The Linux path is unchanged. The suite's TOCTOU battery previously stood down to eighteen
  unfailable `check(name, true)` cells off Linux; it now drives all of them on any POSIX platform,
  including the three controls that show the unpinned pattern still deletes and leaks outside the
  home. Two cells cover the working-directory pin's own failure modes.

  Windows is unchanged and still refused before launch: Jcode's released Harness API bridge is a
  Unix-socket surface.

### Patch Changes

- e2cba27: The Jcode MCP bridge entry is written `shared: true`, so the per-seat daemon pools one bridge process and reuses it across sessions. Under `shared: false` every subagent session spawned its own bridge and none stopped before seat teardown, so seats running repeated subagents accumulated bridge processes without bound. Pooling stays inside the seat: the daemon, its home, its socket, and its relay token are all private to the seat.

## 0.37.0

### Minor Changes

- 4feb60d: Jcode credential mirroring pins copy, mkdir, and unlink through one Linux `/dev/fd` parent walk, and names a refusal when that traversal is missing. A managed Jcode seat now launches on Linux only, so a macOS user loses managed seats.

### Patch Changes

- 1cd9e6b: Remove stale Jcode credential mirror files when their allowlisted sources disappear.
- 11be292: Deliver directed peer messages into an active Jcode turn through the recipient session's soft-interrupt queue, committing them only after the containing turn succeeds.
- 0660504: Steer directed Jcode inbound while the Harness session is busy even without a Cotal-owned drive, and publish automatic queue depth and age on presence activity.
- e703873: Report connector harness availability at manager boot and expose resolved binary paths in status.
- 0365fa1: Name Jcode model startup refusals and persist connector diagnostics in each managed seat home.
- d8b6e63: Refuse a `cotal_spawn` model pin the manager did not record, and name the recorded pin on the spawn result and orientation card so a dropped override cannot look like cross-vendor confirmation.

  A Jcode variant-tier refusal now names the requested model pin rather than the session default RuntimeInfo still reports after setModel.

- c11207f: Keep a Jcode mesh seat alive when the first private bridge replacement fails transiently by retrying launch and session attach inside one bounded recovery window, while refusing another launch unless the failed replacement is proven stopped and terminating immediately on permanent SDK refusals.
- b88edd9: Connectors declare `supportsToolListAnnounce` (default-deny). A connection-changing op against a connector that cannot announce a tool-list change fails loud, without naming harnesses in shared code.

## 0.36.0

## 0.35.0

### Minor Changes

- d457d7f: Show each managed seat's model and requested variant in the default `cotal ps` view, and expose Jcode's declared local model catalog without presenting configured effort tiers as provider-verified capabilities.

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

### Minor Changes

- 4ef59c3: A spawned seat now receives a constructed environment (PATH/HOME/locale, the machine-wide COTAL\_\* knobs, connector-declared provider keys) instead of the manager's ambient environment. Host-session markers such as CLAUDE_CODE_CHILD_SESSION no longer leak into seats and silently disable transcript saving. The Claude connector declares CLAUDE_CODE_OAUTH_TOKEN (and the rest of claude's documented credential set) so a container seat still authenticates; spawn.env remains the explicit opt-in for extra names, including a host marker a persona has chosen to receive.

### Patch Changes

- a93ef08: `--variant` now selects a Jcode seat's reasoning effort instead of failing loud.
  The connector declares `supportsModelVariant`, takes the tier from `--variant`
  or a persona's `variant:`, and the host applies it to the session after the
  model and before the seat's first turn — so no turn is ever served at an effort
  nobody chose.

  The tier is validated by Jcode, which owns the per-provider, per-model ladder
  and names the accepted set when it refuses; the connector keeps no copy of it.
  A rejected tier, or a model with no reasoning-effort surface, ends the launch
  rather than clamping to a neighbouring effort. Its public diagnostic is limited
  to the requested tier, effective model, fixed provider code, and a safely parsed
  accepted ladder, never arbitrary downstream error text. Omitting the variant
  keeps Jcode's own configured default.

  The mandatory `cotal_orientation` readiness proof now repeats once when Jcode's first turn ran
  against the pre-MCP tool snapshot. A second absence still refuses the launch; the retry is bounded
  and never advertises an agent whose mesh tools were not proven callable.

## 0.30.2

### Patch Changes

- 8d50f44: The jcode connector now handles macOS and BSD process-exit races during private-instance teardown
  without hiding operational `ps` failures. A failed per-PID inspection is treated as a vanished
  process only after an independent PID probe proves it no longer exists.
- dff171c: connector-jcode: a managed seat no longer updates its own binary

  Jcode's background updater restarts the process tree when it lands a release. That restart
  SIGTERMs the seat's TUI, which is the only connection the Jcode server counts as a client, and
  nothing re-attaches afterwards — so the server's idle reaper shuts the whole seat down five
  minutes later, mid-turn, with `exit code 1, signal 0` and no signal from the manager. The seat's
  version is now the operator's choice at spawn time and cannot change under a running agent.

## 0.30.1

## 0.30.0

### Patch Changes

- 36d23ed: A failed jcode turn is now retried with a growing delay and a give-up budget, instead of instantly
  and forever. A turn's batch is acked only on success, so a failure left the wake count positive and
  the `finally` re-drove the same batch with no pause and no limit, re-paying the full injection to
  the provider on every pass. Retries now start at one second, double to a one-minute ceiling, keep at
  most one timer in flight, and stop after eight consecutive failures with the batch left un-acked so
  it redelivers. A failing seat also reports `waiting` rather than `idle`, because a seat holding an
  un-acked batch and pacing a retry is not idle.
- b282f70: Honor a connector's declared startup readiness window and make Jcode provider launch refusals diagnosable without exposing private harness output.
- b69d2bb: Jcode now relays the advertised `cotal_inbox` `peek` argument while preserving its host-owned
  pull-only inbox scope. `peek: true` shows buffered quiet ambient without clearing it; explicit
  `peek: false` and omitted arguments retain the normal destructive pull.
- 9626206: The jcode connector now owns the full private-instance shutdown path instead of trusting mutable
  SDK registry PIDs. Each launch carries a random launch-bound identity and captures immutable process
  start tokens before teardown; a PID from `servers.json` or `active_pids` is signalled only when it
  matches that launch, so stale records can never kill an unrelated process tree. Shutdown stops the
  bridge first, waits through a bounded quiescence window for late daemon records, and then tears down
  the exact recorded or already-captured launch processes before the host returns.
- a7386cb: Keep a managed Jcode seat alive when a provider failure closes its private Harness API connection
  mid-turn. The connector now leaves the failed turn unacknowledged, makes one private replacement,
  reattaches the same owned session, and then resumes mesh delivery. A failed replacement or a second
  connection loss fails loud instead of retrying bridge launches without bound.
- 3443c57: Stabilize Jcode startup around asynchronous MCP registration: retry the mandatory orientation proof once, preserve loud refusal when it remains unavailable, open the foreground TUI during readiness, and issue the stale-orientation notice only after a completed mesh join.

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

### Patch Changes

- 5fc753f: A jcode seat now records which provider is actually carrying its model, and refuses a
  provider-prefixed model id at the launch boundary. The connector already refused to join under a
  model label it did not receive, but that guarantee stopped at the model: a seat could be truthfully
  labelled while its traffic was carried by a component nobody named, and `RuntimeInfo` already
  carried the provider and routes in the same response the model check reads. A `provider/model`
  specifier was forwarded verbatim to an endpoint that expects a bare id, so the refusal came back as
  `model_not_found` naming neither the connector nor the prefix; it is now refused where the accepted
  form can be named.
- bd4fb99: A restarted jcode seat now resumes the session it left instead of silently starting blank. The host
  called `createSession` unconditionally, so `cotal stop` followed by `cotal spawn` forked a new
  session and orphaned the existing transcript: the seat came back looking healthy while remembering
  nothing, and the TUI, which is spawned with `--resume`, showed an attaching human the very history
  the agent could not recall. The host now looks for a prior session in the seat's own home and
  attaches it, choosing conservatively: the session must declare this seat's working directory, must
  not be archived, and must carry a non-empty transcript. When nothing is resumable it starts fresh
  and says so, and when it does resume it does not re-send the persona briefing into a transcript that
  already opens with it.

## 0.27.0

### Minor Changes

- 900f630: Add the Jcode Harness API connector with a private managed session, Cotal MCP bridge, and operator documentation.

### Patch Changes

- f982ef2: Use a short private API socket path and copied auth mirror when starting Jcode seats.
