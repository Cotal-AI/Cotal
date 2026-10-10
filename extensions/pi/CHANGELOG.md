# @cotal-ai/pi

## 0.78.0

## 0.77.1

### Patch Changes

- a1948eb: The Codex and Jcode hosts now arm the event plane when the session's registration requires events, even without `COTAL_EVENTS`. They used to read only that flag, so a hand-driven user-mode launch with `COTAL_EVENTS_REQUIRED=1`, or a custom launcher that passed `eventsRequired` with events opted out, ran with no event plane and the required-events policy never applied. The Claude, OpenCode, Codex, Jcode and Pi launches that carry `eventsRequired` now also set `COTAL_EVENTS` and the workspace root when the launcher passed `events: false`, so the armed session has a place for its event log. Both decisions go through `launchArmsEvents` and `eventPlaneArmed` in `@cotal-ai/connector-core`; an OpenCode 2.x session still reads only `COTAL_EVENTS`.

## 0.77.0

## 0.76.0

## 0.75.0

## 0.74.0

### Patch Changes

- ad81083: The connector on/off flags `COTAL_CHANNEL`, `COTAL_EVENTS`, `COTAL_EVENTS_REQUIRED`, `COTAL_CODEX_TUI` and `COTAL_JCODE_TUI` now share one parser in `@cotal-ai/connector-core`. It accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` in any case, treats an unset or blank value as unset, and refuses anything else at startup with an error naming the variable and the value. Before, each connector kept its own copy and read any other value, such as `enabled`, `2` or `y`, as off without a word. The OpenCode 2.x adapter now refuses `COTAL_EVENTS=true` the same way it refuses `COTAL_EVENTS=1`, where before only `1` was refused.

## 0.73.0

## 0.72.1

## 0.72.0

## 0.71.0

## 0.70.2

## 0.70.1

## 0.70.0

### Minor Changes

- 76113ce: `AguiEmitterHolder` now takes its hooks as one named object after the emitter factory, `new AguiEmitterHolder(startEmitter, { onError, onRunClosed, waitLive, runMeta })`, typed by the exported `AguiEmitterHolderHooks`, where only `onError` is required. Before, the four hooks were positional, and a `runMeta` provider passed third was accepted as `onRunClosed`: it typechecked, ran after the run had already closed, and its metadata was dropped with no error. A caller no longer fills earlier slots with `undefined` to reach a later hook. The Claude Code, Codex, jcode, OpenCode and pi connectors pass their hooks by name, with no change in behavior.

### Patch Changes

- 95788eb: A seat whose AG-UI event plane stops for good now follows the space's policy on every connector. On a space that requires events the seat stops, where Pi, Claude Code and OpenCode used to keep it running without events. On any other space the seat keeps running and its log records `AG-UI emitter stopped`, where Jcode used to stop the seat and refuse further turns. Codex no longer rebuilds a stopped plane at its next turn boundary on any space, and it now waits for the mesh before starting its emitter, as the other connectors do. The rule is `eventPlaneStopped` in connector-core, which each connector passes its log sink and its stop hook.
- 8dbfb8e: A pi seat now marks a run turn as shown once the provider takes the request that carries it, instead of after the whole Pi turn ends. A `cotal_yield` made during that turn used to be refused with "no turn is active — nothing to yield", and the run then recorded `done` where the seat had said `blocked` or `handoff`. On a transport that reports the provider response, the unshown turn was also injected again after every response, so the Pi turn never ended and the run turn ran out its deadline. A transport without that report shows the turn when Pi runs a tool from the answer, or at the clean end of the turn.

## 0.69.0

## 0.68.0

### Minor Changes

- 585fdb2: Connectors launch on the model and variant their launcher resolved. `LaunchOpts.model` and `LaunchOpts.variant` are now the launcher's resolved values (the flag, else the agent file's `model:` / `variant:`), and every connector renders them as given instead of reading the agent file again in `buildLaunch`. Before, a model the launcher did not resolve was taken from a later read of a file that could have changed since, so the seat could run a model the launcher never checked or recorded, and a supervised restart re-read it each time. The in-session config takes the model and variant from `COTAL_MODEL` / `COTAL_VARIANT` only, so the card and the orientation pin no longer report a model the seat was not launched on. The Hermes connector no longer falls back to `HERMES_MODEL` from the spawning process, including one `spawn.env` forwards; set the model with `--model` or the persona's `model:`. Code that calls `buildLaunch` directly must pass `model` and `variant` itself.

## 0.67.0

## 0.66.1

## 0.66.0

## 0.65.0

## 0.64.0

## 0.63.0

## 0.62.0

## 0.61.0

## 0.60.0

### Patch Changes

- 3b616a2: A manifest agent can declare `continuity: exact` to come back in its previous harness session. The manager records the session the connector proves over its authenticated control endpoint on the first launch, keeps that record current through crash recovery, preserved resume and stop, reopens it on every later launch and preserved resume under the same proof, and refuses one recorded for another space, connector or directory. A reopen fails when the harness no longer has the session rather than starting an empty one under the same id: connectors declare the new `supportsSessionReopen` capability and honor `LaunchOpts.reopenSession`, and Pi reopens with `--session`. Preflight refuses `exact` on a connector that cannot reopen an existing session.

## 0.59.0

### Patch Changes

- 5f13124: Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once it has proved the agent process gone. On the default pty runtime the manager removes them when it sees the agent exit; on tmux, cmux, orca and herdr the manager removes them by polling the seat's status and waiting for the runtime's exit proof; the foreground `cotal spawn` removes them when its child exits. Every one of those launches also starts its child through the new core `reclaimWithChild`: a watcher started beside the child removes the files once the child's process is gone, and tries a failed removal again every five seconds until it succeeds, so a killed manager or foreground `cotal spawn` no longer strands them (POSIX; Windows has no shell for the watcher). Each directory name carries a random per-launch identity, so a stale path can never name a later launch's directory. The tmux, cmux, orca and herdr runtimes now throw the new core `SpawnRefused` for an unsafe name, an unreachable backend, (herdr) a missing working directory or an unknown layout, (orca) a working directory that is missing or outside any Orca worktree, and a launcher script they cannot write or (tmux, herdr) a session or server that will not start, all before the agent's command is handed to the backend, and the manager removes the files at once. A removal that fails, after an exit or after a refusal, is tried again until it succeeds. A batch resume removes the files of specs it built and never launched. Both connectors now refuse a bad model, prompt or launch option before writing anything. Any other spawn that throws is not proof that nothing started, so its files stay for the child's watcher, or for the OS temp reaper when no child started, as do a killed launcher's on Windows. A seat started under a custodian with `launchSeat` from `@cotal-ai/seat`, which the manager no longer does for a new launch, hands them to that custodian: a launch it refuses before any process started removes them at once, the custodian removes them when it sees the agent exit, a removal that fails stays on the custody record, and a reap that proves the seat gone removes what the record still lists from the temp dir the launch wrote to, so a successor with a different `TMPDIR` still removes them. Losing a custodian's connection no longer counts as the agent's exit. The docs now say that owner-private means any process running as the same user can read the file while it exists.
- 8ce6be3: The 0.33.0 changelog entry "An agent now reads only the channels it lists" now carries a correction. It presented the read-set default-deny as new in 0.33.0, but that shipped in 0.28.0 with #821, so upgrading from 0.28.0 or later needs no migration for it. The correction names what 0.33.0 did change: the no-default-channel check in `multicast` now refuses only an omitted channel, so an explicit empty-string `channel` is no longer refused as if it were omitted, and its refusal is reworded; the `cotal_send`, `cotal_leave` and pi tool text; doc comments; and two regression suites. `docs/release.md` now describes how to correct a released entry.

## 0.58.0

## 0.57.0

## 0.56.1

### Patch Changes

- 6b76946: A seat resumed from a preservation cut backfills its channels from the chat stream sequence its prior incarnation had reached instead of replaying the whole retained window.

## 0.56.0

## 0.55.0

### Patch Changes

- cb869b7: A pi seat held after a non-terminal `agent_end` (error or an unknown stop reason) with a Cotal batch pending now has a bounded exit: the driver retries the continuation itself a fixed number of times with a fixed backoff, through the same send path a human continuation uses, before holding for operator intervention with a presence that names the attempt count and what to do. User abort still holds without any automatic retry: the person who aborted is the party who continues. Fixes #726
- d284ee6: A manifest or spawn prompt on a connector that cannot deliver one is refused at preflight (including `up -f --dry-run`), at spawn and in the manager, the way an unsupported model variant is: connectors now declare `supportsPrompt`, and claude, opencode, codex, jcode and pi declare it; hermes keeps its launch-time throw as the second line of defence.

## 0.54.0

## 0.53.0

## 0.52.1

## 0.52.0

### Patch Changes

- 3322a2c: The pi adapter hands pi the plain Zod JSON Schema render instead of a TypeBox-branded copy, so a JSON round-trip of every tool's parameters carries only schema keywords and a strict provider no longer refuses the declarations.

## 0.51.0

### Minor Changes

- ec8649b: Preserve the closed required-events registration policy and enforce it across discovery, launch,
  grant coverage, direct connector sessions, and trusted upgrades of existing manual registrations.

### Patch Changes

- 7885a2b: Publish Pi's native persisted assistant and tool boundaries as durable AG-UI events at completed-message granularity.

## 0.50.1

## 0.50.0

### Patch Changes

- 0a52594: Census the in-process half of the ambient-environment rule. `smoke:suite-ambient-env` grades the environment a suite hands a child; the new `smoke:suite-ambient-env-self` grades a suite that reads its own `process.env` through `configFromEnv` and friends, and requires a module-scope `COTAL_` prefix scrub before that first read. The connector suites in the class now scrub the whole prefix instead of dropping one variable, so running them from inside a connected session no longer dies in its own import on the one-identity-plane refusal.

## 0.49.0

### Minor Changes

- 36d1779: Issued authority and run admission (SPEC 13.15, 14.8). A static credential is now an issuance: the issuer records its permission ceiling as evidence under a fresh generation before the material exists, its endpoint rows ride the versioned `ep.v1` rail with that generation pinned beside the caller triple, and a connected client reads its generation from an issuer-written accepted row. A hosted workflow run is admitted under the starting caller's resolved ceiling, recorded once per run in a dedicated admission store the driver cannot write, checked before every channel effect (wait open, fetch, recorded re-read, conclave writes), and revoked by an independent create-only marker that ends open waits at their next poll and refuses resume, takeover and reconcile. `run-start` on the legacy rail is refused with `permission-denied` and the `ai.cotal.ep.unbound-caller-authority` detail. `cotal run start --local` takes `--admit-read` and `--admit-publish` (required) and `cotal run revoke <runId> --local --by <who> --reason <text>` writes the marker. Three new per-space stores (`cotal_issued_`, `cotal_accepted_`, `cotal_admission_`), immutable at the broker: the admission and accepted stores are write-once per key, the evidence store is append-only and read first-on-key, and all three refuse rollup headers, message deletes and purges, so a holder of its own key row can neither widen nor erase what was recorded. Two new one-shot profiles (`issuer`, `run-admitter`), an admission read on the run mediator and operator profiles, and `COTAL_ACCEPTED_TOKEN` on every connector's spawn environment. Breaking pre-1.0 authority change.

## 0.48.2

## 0.48.1

## 0.48.0

## 0.47.1

## 0.47.0

## 0.46.0

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

### Minor Changes

- a87709c: Every cotal-lang effect now performs on the mesh: the durable-action group is built end to end and
  the not-yet-durable seam is gone.

  `spawn` submits a real manager goal and returns the allocated seat's handle, and meters the
  agent's `permits` (`turns`, `wallClock`; the turn that would exceed one is L4001, and a budget the
  host cannot meter is refused at spawn); `conclave` opens a scoped sub-team as durable membership
  rows; `ask` parks schema-checked pauses answered through `cotal run answer` and tells the agent
  over the turn relay, one relay per attempt carrying the schema, the attempt and the previous
  refusal, which every connector's intake renders with the answer command; `monitor` registers the
  handle on its journal entry and `wait(down)` reads a monitored incarnation's death off presence
  liveness, refusing an agent nobody monitored.
  `turn` rides a new pull-shaped manager relay: the manager serves `turn` (targeted, the
  despawn/input reach) plus `turn-pending` and `turn-yield` (self reach, manager contract revision
  10), holds the payload on the goal-index note, pins the goal to the seat's incarnation, and denies
  at a goal-bound deadline hold; the seat side (all connectors) pulls pending turns, surfaces them
  two-phase into host context, auto-yields `done` when the host turn ends, and yields `blocked` or
  `handoff` through the new `cotal_yield` tool; the run client renders context with pending notices,
  arms its own pause on the acceptance's deadline as the L4003 authority, watches presence as the
  L4002 authority (a death the manager marks on the deadline terminal reads the same way), and
  honors handoffs (L4005/L4004 validation, the `handoffFrom` goal chain); the manager shows a seat
  one turn at a time. The relay holds on an auth mesh: the agent baseline gains the self-mode
  `turn-pending` and `turn-yield` rows, the operator seat-write set (`control-caller-admin`, the
  `admin` capability) gains `turn` beside `input`, and the manager mints the deadline hold's
  schedule over its serve connection and owner-expires the hold once due instead of reading a
  fire it holds no grant for. `wait(replied)` observes the run's own turn terminals as a level, and never a
  turn the run itself ended without an accepted yield. A `spawn` may bind a logical worktree: the
  validator rejects two literal-worktree spawns in one concurrent scope (L3022, named branch
  functions included) and the runtime claims a tree before it submits, refusing a second spawn into
  a tree held by a live seat or by a spawn in flight (L4008), with sequential reuse the moment the
  holder's presence lapses. A spawn refused at accept is L4000 (L4001 for seat capacity) and one
  whose seat never came up is L4002; an `ask` whose deadline passes with no conforming record is
  L4006; a fork copies a spawn that said `onFork: "adopt"` and refuses one that would have to
  respawn (L5019). The run driver re-issues
  recorded-but-undischarged cancellations at adoption, so recovery does not wait for completion to
  release a dead loser's seat, pause, or tree. A migration's `--adopt <handle>` hands the orphaned
  seat to the edited program's next spawn of that persona, and `--release <handle>` despawns it at
  commit through the run's own discharge; both name the agent the step spawned, and a spawn that
  produced none is an orphan like a sleep; the adopting spawn binds the orphaned spawn's goal as
  its own, so a resume re-reads the seat and a cancellation despawns it. A turn accept the manager
  cannot finish unwinds to a failed terminal on its bound goal, and a retry of it is refused naming
  that terminal. The delivery daemon hosts the checkpoint timer writer, so mediated deadlines fire
  with no suite pump.

## 0.41.4

## 0.41.3

## 0.41.2

## 0.41.1

## 0.41.0

## 0.40.0

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

## 0.37.0

### Patch Changes

- e703873: Report connector harness availability at manager boot and expose resolved binary paths in status.
- c4094cb: Drop inherited `COTAL_LAUNCH_MATERIAL` from suites that default `COTAL_SERVERS` then call `configFromEnv()` on `process.env`, so `pnpm test` no longer trips the one-identity-plane refusal inside a managed seat.

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

### Minor Changes

- ba74c84: An agent now reads only the channels it lists. An omitted or empty read set means **no channels**,
  where it previously meant `general`: the agent-file loader, the provisioner, the credential mint and
  the endpoint each defaulted an absent read set to `["general"]`, so any persona that simply did not
  mention channels was subscribed to `general` by code and had the matching channel read row baked
  into its credential.

  An agent on no channel is still a full mesh peer: it appears on the roster and sends and receives
  DMs and anycasts, and the same default-deny that already governed `allowPublish` now governs reads.
  An empty list and an omitted one mean the same thing, for both read keys. That has one consequence
  worth stating plainly: when **both** are omitted, `allowSubscribe` falls back to the read set and so
  resolves empty too, which leaves the agent unable to `cotal_join` a channel at runtime. Give it an
  explicit `allowSubscribe` if it should be able to join one later.

  With no concrete channel there is no default broadcast target, so a send with no explicit channel is
  refused with a message saying so, rather than resolving to `general`. Leaving your last channel is
  allowed and always was; the `cotal_leave` description said otherwise and now says what actually
  happens, including that the default send channel is gone until you join one.

  Migration: **list `general` explicitly if you want it.** A hand-written persona that relied on the
  old default needs `subscribe: [general]` added.

  This changes the default `cotal setup` install as well. The seeded `default_agent` carries
  `subscribe: []`, which used to resolve to `general` and now resolves to no channel; it keeps
  `allowSubscribe: [">"]`, so it can still `cotal_join` anything, it just no longer arrives on a
  channel it never asked for — which is what its own seed comment already described.

  Already-running agents are not narrowed retroactively: a live seat keeps the read ACL its credential
  was minted with, across renewal, until it is respawned.

  **Correction:** the read-set default-deny described above is not new in 0.33.0. It shipped in 0.28.0
  with 86f6b10 (#821, "Remove the implicit `general` channel floor"), and so did the refusal of a send
  with no channel and the no-channel default for the seeded `default_agent`. Upgrading from 0.28.0 or
  later needs no migration for it. What 0.33.0 changed is narrower. The no-default-channel check in
  `multicast` now refuses only an omitted channel (`channel === undefined` where it was `!channel`), so
  an explicit empty-string `channel` is no longer refused as if it were omitted, and the refusal now
  says to name or join a channel. The `cotal_send` and `cotal_leave` tool descriptions and pi's send
  call line no longer name `general` as a default or say the last channel cannot be left, doc comments
  state the rule and the both-keys-omitted consequence, and the `smoke:no-implicit-general` and
  `smoke:session-channels` suites guard it.

## 0.32.0

## 0.31.0

### Minor Changes

- 4ef59c3: A spawned seat now receives a constructed environment (PATH/HOME/locale, the machine-wide COTAL\_\* knobs, connector-declared provider keys) instead of the manager's ambient environment. Host-session markers such as CLAUDE_CODE_CHILD_SESSION no longer leak into seats and silently disable transcript saving. The Claude connector declares CLAUDE_CODE_OAUTH_TOKEN (and the rest of claude's documented credential set) so a container seat still authenticates; spawn.env remains the explicit opt-in for extra names, including a host marker a persona has chosen to receive.

## 0.30.2

## 0.30.1

## 0.30.0

### Minor Changes

- 569f4d3: An empty message id is never a dedup key, and an id-less delivery is individually addressable at the drain seam.

  Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
  dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
  first was handled it dropped every later empty-id message on arrival. Measured live, two
  such messages arrived on the wire and only the first was ever delivered.

  An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
  is skipped for it in both directions, so distinct messages that carry an empty id are all
  delivered. At the drain seam a per-delivery receive key (the wire id when there is one, a
  per-session secret-namespaced minted key when the id is empty, never on any wire) is what
  hosts, adapters, and the exact-key drain select by: cotal_inbox, the Claude Code hooks,
  the OpenCode plugin, the Codex host, the Hermes bridge and its Python sidecar, and the pi
  driver. The drain API is renamed for what it takes (drainInboxDeliveries, missingKeys).
  Eviction classification, in-flight holds, scope routing, the focus-recall tie-break, and
  the scoped drain's selection no longer key on the empty id either. The Hermes bridge no
  longer wedges on an empty-id message. Delivery pumps in core now treat an absent or
  non-string id as a malformed envelope per SPEC section 5 (durable terminate, live drop,
  history and recall skip).

  What this restores: before the receive key, an id-less delivery was unaddressable: the
  raw id swept every pending empty-id item in one drain call, and once filtering closed
  that, the item could never be drained or acked, was re-shown on every windowed inbox
  read, and on a durable channel accumulated as an unretirable entry until the 200-entry
  overflow valve evicted it, roughly a model turn of churn per entry, while one hostile
  empty-id ambient publish self-drove back-to-back host turns on the pi adapter. This was
  a violation of the SPEC section 8 ack-only-after-surfaced obligation at the receiver,
  not only an adapter defect.

  The cost is stated rather than hidden: with no id there is no coalescing either, so a
  redelivered copy of an empty-id message can surface twice on a path that is already
  at-least-once (live remains at-most-once). Dedup for real ids is unchanged: their
  receive key is their wire id and their coalescing is untouched. SPEC section 4, section
  7 item 5, section 8, and section 12 item 12 now state the receiver-scoped rule, and the
  client-builder guidance mirrors it.

  One named follow-up stays open: Plane-3 durable fan-out derives its publish msgID from
  the message id, so distinct empty-id messages can still be collapsed inside the broker's
  duplicate window on a durable channel before this receiver sees them. That path is its
  own issue; this change's guarantee is the receiver.

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

### Patch Changes

- 3866fdc: Let already-running managed Pi seats adopt crash recovery after an extension reload. Seats launched before the session-state environment variable existed derive the same lifecycle-keyed state path from their manager-owned persona file and lifecycle UID, then record the active Pi session atomically. Fresh managed seats also receive a Pi-native exact session ID before their first turn, so an idle seat is recoverable.

## 0.25.0

### Minor Changes

- a087c2b: A spawned agent now inherits the operator's environment. A harness you installed and configured
  should behave under `cotal spawn` the way it behaves when you run it yourself, and the alternative
  was Cotal maintaining a list of inference vendors: every new provider needed a change in Cotal
  before it would work through a managed spawn. `MODEL_PROVIDER_KEYS` and the per-connector lists
  that extended it are gone, and Cotal no longer names an inference vendor anywhere in its source.

  Cotal still resets its own `COTAL_*` namespace before the child starts, keeping the machine-wide
  knobs (`COTAL_HOME`, the feedback set, the default-agent pair, the `*_BIN` overrides, the timing
  knobs). That reset is not configurable, because it is identity and not preference: a connector
  supplies the per-session names for each child and does so conditionally, so an inherited value is
  never overwritten and would hand an agent another agent's credential path, ACL, or lifecycle uid.
  The whole prefix is stripped rather than a named list, because which names a connector sets varies
  between connectors and a deny-list only ever names what its author remembered.

  To confine a spawned agent instead, declare `spawn.env` in the cotal config file. The child then
  gets a fixed OS allow-list plus exactly the names you list. An empty array is a real policy meaning
  the OS allow-list alone. Note what this does and does not buy: `HOME` is forwarded either way, so
  an agent with a shell reads `~/.aws` and `~/.ssh` regardless, and this protects only secrets that
  live nowhere but the environment.

- 0b602e4: Managed Pi sessions can now fork an existing Pi transcript into the mesh and recover the exact active Pi session after an unexpected process crash. The Pi adapter reports session changes through its authenticated local control endpoint and an owner-only atomic state file; the manager preserves the Cotal identity, lifecycle UID, credentials, children, and durable inbox across up to three restarts in two minutes, then retires a crash loop loudly. Deliberate stops never restart.
- 34caaf4: Agent seats no longer export their connection material into the environment every descendant
  process inherits. The broker URL, the creds path, the auth token, the user-mode identity and the
  local control token now ride a private 0600 launch-material file whose path is the only thing in the
  seat's environment; pi, codex and OpenCode drop even that path once they have read it (for OpenCode
  that happens in the `opencode serve` process its seat shim starts, which is also what runs the
  session's tool calls), while claude and hermes keep the reference because their readers are
  short-lived children that start later. A session driven by hand still sets `COTAL_CREDS` / `COTAL_SERVERS` itself, and a
  launch that carries both carriers is refused rather than resolved by precedence.

### Patch Changes

- bf07e45: Wrap visible Cotal inbox and tool text by terminal columns instead of JavaScript string length. Emoji and CJK text can occupy two terminal cells per code point; a peer status line containing two check marks was emitted at 122 cells in a 120-column Pi TUI and terminated the process. The Pi adapter now uses the host's canonical ANSI/grapheme-aware wrapper, with a regression fixture from the live crash.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

### Patch Changes

- 219d33c: `cotal spawn --agent pi --prompt <text>` now delivers the prompt as Pi's initial message (its first turn) instead of silently dropping it; an empty prompt, or one starting with `-` or `@`, refuses the launch. The connector contract no longer describes an initial prompt as something a connector may ignore: a connector delivers it or throws at launch. The other connectors follow the same rule: Claude Code and Codex refuse a prompt that is empty after trimming instead of dropping it, and Hermes refuses an initial prompt outright until its first turn is wired.

## 0.20.1

## 0.20.0

## 0.19.0

### Minor Changes

- 4e8d776: The `cotal_*` tools now refuse an argument they do not model instead of silently
  dropping it. A call carrying an unmodelled key (`owner` or `actor` alongside the
  real arguments) previously succeeded with that key stripped before the tool ran,
  so the caller was told nothing and the tool did something other than what was
  asked. It is now refused by name, on every adapter and on every tool: the MCP
  renderers and pi publish a closed schema and the host rejects the call, while
  OpenCode and Hermes pass the caller's object through untouched and are closed at
  the connector's own dispatch. Tools that take no arguments are closed too: they
  were previously published with no schema at all, so a host had nothing to check
  against and forwarded the extras to be dropped, as is `cotal_inbox`, whose
  arguments four of the connectors replace with their own. Behaviourally breaking
  for any caller that was relying on extra keys being ignored. Every refusal names
  the rejected keys; where the connector is the one refusing it also lists the
  arguments the tool accepts, or says it takes none.

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

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.

## 0.11.3

### Patch Changes

- 1a954e8: Add the Pi host-native connector with confirmed custom-message delivery, cooperative shutdown, and a standalone extension artifact.
  - @cotal-ai/core@0.11.3
  - @cotal-ai/connector-core@0.11.3
