# @cotal-ai/manager

## 0.28.0

### Minor Changes

- 86f6b10: Remove the implicit `general` channel floor: undeclared access now grants nothing

  An agent that declared no channel access used to fall back to `["general"]` for its
  active read set and read ACL. That floor was applied in seven places — the provisioner,
  the agent-file loader, the manager's spawn path, the CLI's `spawn`, the connector's
  config resolver, and the endpoint's own channel list — so an agent with no frontmatter
  silently joined a channel nobody had granted it.

  The fallback also could not see the credentials it was guessing against. On a manifest
  spawn the materialized persona carries no access frontmatter, so the connector fell back
  to `general` while the minted creds allowed only the manifest's channels; the broker then
  refused the subscription and the agent joined nothing, with no error naming the cause.
  `COTAL_SUBSCRIBE` forwarding was added to paper over exactly this.

  Undeclared read is now empty, matching the repo's no-fallbacks rule and the existing
  default-deny on `allowPublish`. `Endpoint.send()` throws instead of defaulting to
  `general` when the endpoint is on no concrete channel — a caller that never declared a
  channel now gets a loud error rather than a message delivered somewhere it never asked
  for.

  The seeded personas change with it: `default_agent` no longer auto-subscribes to
  `general` and no longer carries a wildcard post ACL (`allowPublish: [">"]` → `[]`,
  default-deny), and the demo personas move to their own `welcome` channel. Channels are
  implicit — created on first use — so no channel provisioning is required.

  Breaking for anyone relying on the implicit floor: an agent that read `general` without
  declaring it must now declare it.

- a84cb62: Saving a persona now requires it to name the channels it reads. `saveAgentFile` refuses a
  definition with no `subscribe`, `cotal personas new` takes a required `--subscribe` (pass
  an empty value for an agent reachable only by direct message and anycast), and a persona
  defined over the wire is created with an empty read set, since that path deliberately
  accepts no policy from its caller, and records that the caller was never offered the
  choice so a reader can tell it apart from a persona whose author chose no channels. Previously a saved persona with no read set inherited
  whatever default was current, so a file could grant a channel its author never chose and a
  later reader could not tell a deliberate silence from a forgotten field. An empty list is
  written rather than filled in, so the two stay distinguishable.

### Patch Changes

- e377c7b: The manager's session signing key now renews itself instead of expiring after a day. It was minted
  once at startup with a flat 24-hour window and the same frozen anchor was returned for the life of
  the process, so any manager with more than a day of uptime lost its session plane permanently: every
  attach failed closed with "outside its validity window", and the only recovery was restarting the
  manager, which kills every live session. Failing closed on an expired key is correct and is
  unchanged; never renewing the key was the defect. The key now rotates once a third of its window has
  elapsed, the previous key stays verifiable for a ten-minute overlap so an artifact signed just
  before a swap is not orphaned, renewal is driven both by a timer and opportunistically before
  signing so a stalled timer alone cannot reintroduce the outage, and the newest key is never dropped.
- Updated dependencies [09b6a3b]
- Updated dependencies [b8ee849]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [45db9f8]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/workspace@0.28.0

## 0.27.0

### Patch Changes

- 08a9cb8: Overlap manager control registration with startup static lifecycle reconciliation, while fencing each reconciling alias from reuse.
- Updated dependencies [900f630]
  - @cotal-ai/workspace@0.27.0
  - @cotal-ai/core@0.27.0

## 0.26.0

### Patch Changes

- 3866fdc: Let already-running managed Pi seats adopt crash recovery after an extension reload. Seats launched before the session-state environment variable existed derive the same lifecycle-keyed state path from their manager-owned persona file and lifecycle UID, then record the active Pi session atomically. Fresh managed seats also receive a Pi-native exact session ID before their first turn, so an idle seat is recoverable.
- f339690: Document capability handles as a distinct cost of default environment inheritance, and make two env-boundary suites real gates.

  The configuration guide told operators that `spawn.env` protects secrets living only in the environment, and reassured them that a shell reads `~/.ssh` either way. That understates what inheritance forwards. `SSH_AUTH_SOCK` names a live `ssh-agent` rather than holding a secret, so an inheriting child can ask that agent to sign for any key it holds, and it keeps that power when no private-key file exists on disk at all. The guide now names capability handles as their own class, states the `ssh-agent` case, and records that model-catalog discovery in the `codex` and `opencode` connectors runs the harness with the operator environment and does not consult `spawn.env`.

  The environment-boundary suite asserted that an unenumerated `COTAL_*` sentinel was absent from a spawned child, but never set it in the parent, so the assertion could not fail. The sentinel is now injected, which makes the cell prove the reset is driven by the prefix rather than by the enumerated per-session list. `smoke:hermes-launch-env` and `smoke:env-isolate` are both added to the sharded CI suite list; the hermes suite carries the connector's inherit, reset and both-containment-mode coverage and was previously reachable only through a package-local command.

- Updated dependencies [aa1fe5f]
  - @cotal-ai/workspace@0.26.0
  - @cotal-ai/core@0.26.0

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
- 8e38835: Carry the manager's readiness guidance on an `uncertain` goal terminal. The manager built a
  diagnosis naming the agent and telling the operator to inspect rather than re-issue, then dropped
  it: the terminal committed core's generic "the success signal did not arrive within the readiness
  deadline", which reads as a plain failure and teaches a re-issue, and a re-issue after a launch
  that actually succeeded mints a duplicate agent. `settleGoalUncertain` now accepts an optional
  `reason` the committer supplies, and the manager passes the detail it already constructed; core's
  line remains the fallback for a committer that supplies none.

### Patch Changes

- 3f1ee2f: `cotal ps --wide` / `--json`: surface the per-seat facts the manager already records. The agent row now carries the model pin (and variant), `cwd`, `pid`, spawner, and the owning manager's instance id and host, all optional so an unrecorded fact (no model pinned; a runtime that owns no real process) serializes absent, never fabricated. Bare `ps` output is unchanged; `--wide` prints one dim facts line under each seat; `--json` prints the manager's row verbatim, one object per line, with instance headers on stderr. No new collection path: every field was already held in the manager's spawn-time record.
- b33ba93: A managed agent's retirement is now requested as the manager's SERVE identity, so it is authorized instead of being refused. The auth rail authorizes a `retireLifecycle` request by comparing the caller's `<owner>.<actor>` against the principal bound into the manager's serve issuance gate, and that gate is opened with the serve identity the manager registers with. The request was built from the manager's endpoint identity instead: a second, equally real identity of the same manager, and one the gate can never name. The comparison was therefore unsatisfiable on every user-auth mesh, so every despawn stopped the agent and then had its retirement refused as a full no-op, leaving the name held and the lifecycle un-retired. Both halves of the caller triple now come from the gate's own sources, the owner included, so a manager running under a user-shaped identity cannot re-open the mismatch in the owner half.
- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/workspace@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [b7cc4fa]
  - @cotal-ai/core@0.24.0
  - @cotal-ai/workspace@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [5634356]
  - @cotal-ai/workspace@0.23.0
  - @cotal-ai/core@0.23.0

## 0.22.0

### Minor Changes

- 57d3a57: A Claude session publishes a structured event plane, and the `tr-<name>` transcript mirror is
  retired

  A session launched with `cotal spawn --events` now actually publishes. The Claude connector maps
  its session records to structured events behind the same hook relay the mirror used to sit behind:
  run boundaries per turn, assistant text, reasoning, and each tool call with its arguments, its end
  and its result, written to a per-session write-ahead log before they go on the wire so a restart
  resumes at its cursor instead of replaying or skipping. Until now no connector constructed the
  emitter at all, so every event channel was empty.

  The `tr-<name>` mirror is removed in the same change rather than deprecated alongside it. Gone with
  it: the `--transcript` and `--no-transcript` flags on `cotal spawn`, the `transcript` field on the
  manager's spawn op and its service contract, `COTAL_TRANSCRIPT` and `COTAL_TRANSCRIPT_DEFAULT`,
  `LaunchOpts.transcript`, `Connector.transcriptChannel`, and the mirror in all three connectors that
  carried one.

  MIGRATION. If you read a `tr-<name>` channel, nothing publishes to it any more. A managed session no
  longer mirrors its prose there under any flag or environment variable, and a spawn that passes
  `--transcript` now fails on an unknown flag rather than being ignored. Read the session's event
  channel instead: launch with `--events` and subscribe to `events.<owner>.<actor>`, which is keyed on
  the session's principal. On a static mesh that is `events.local.<key>`, where the key is what the
  manager allocated and the spawn reply carries it as `id`; on a user-auth mesh it is
  `events.<your-owner>.<agent-name>`, where the actor half is the agent's own name. `connect-claude.md`
  gives both forms. `cotal console` and the web console render event frames directly. Unlike
  `tr-<name>`, you cannot simply subscribe: the plane needs an out-of-band grant, and the command for
  it is under "To let something read a plane" below.

  What you gain and what you lose, both stated. A tool call now arrives with its full arguments, its
  end and its result, in a vocabulary a program can read, where the mirror gave a truncated one-liner
  of glyph-prefixed text. What you lose is prompt text somebody else wrote: the mirror republished
  every prompt, and the event plane withholds the body of a turn the agent did not author, because
  republishing a peer's message onto a channel that peer may not read crosses an ACL boundary. A
  peer-authored turn still opens a run and still shows the work it caused. One stated limit on that,
  because the loss column is only useful if it is complete: a tool result is this session's own output
  and is republished, so peer text quoted inside one still reaches the wire. A cell in
  `agui-authorship.smoke.ts` holds that as a measured limit rather than leaving it to be discovered.

  A spawn may be granted the event plane of the agent it is creating, and no other. A spawn that names
  a different agent's event channel in `allowSubscribe` or `allowPublish` is refused at the door,
  because that channel carries the session's tool inputs and outputs. The same rule runs on a manager
  resume: a retained inventory naming another agent's event channel is refused rather than adopted.

  The rule reads a **concrete** channel, two principal tokens and nothing else. A pattern such as
  `events.<owner>.>` is not an event channel to it and passes untouched, governed by ordinary ACL
  authority. That is deliberate, since the pattern is the form an operator writes on purpose for an
  observer.

  To let something read a plane, grant it out of band. The refusal prints one command, spelled out in
  full, for the mesh it is running on. On a user-auth mesh:
  `cotal actor grant <reader> --owner <owner> --scope '' --allow-subscribe '<channel>' --allow-publish
''`, every field named because `actor grant` is an upsert of the whole row and an omitted flag is the
  wide default (`>` read, `>` post, `spawn,role:default` scope), not "leave it alone". On a static mesh there is no
  actor ledger for `actor grant` to write to, so mint the reader instead:
  `cotal mint watcher --profile agent --allow-subscribe '<channel>' --provision`, the agent profile and
  not the observer one, since `mint` reads `--allow-subscribe` only for that profile and refuses it off
  that profile.

  `cotal mint` now REFUSES `--allow-subscribe` / `--allow-publish` off the agent profile rather than
  ignoring them. Those profiles carry a FIXED read set, the chat plane for observer and the whole
  messaging plane for admin, so
  `--profile observer --allow-subscribe <one channel>` used to exit 0, print a success line, and hand
  out a credential that reads every channel in the space: an operator asking to narrow got the
  opposite, silently. `--role` and `--provision` were already refused there for the same reason. The
  rows in `cli.md` and the sentence in `build-a-client.md` now say the same thing.

### Patch Changes

- Updated dependencies [57d3a57]
  - @cotal-ai/workspace@0.22.0
  - @cotal-ai/core@0.22.0

## 0.21.0

### Minor Changes

- 4cf5f72: Give a session's structured event plane a way to be turned on, and a channel that names who is publishing.

  An agent can now be launched with `cotal spawn --events`, foreground or detached, which publishes
  that session's structured event stream, what it did rather than the prose it wrote, on a channel of
  its own so an external observer or UI can read it. Off by default. Nothing about an existing launch
  changes.

  **The channel is named after the principal, never the display name.** It is `events.<owner>.<actor>`,
  derived from the principal the manager actually allocated. A display name is UI convenience: this
  mesh permits two live agents to carry one, and the manager itself auto-numbers a collision, so a
  name-keyed channel would fuse two principals onto one subject and, in auth mode, would authorize both
  onto it from a value that identifies neither. The derivation is a single function on the connector
  contract, `eventChannel`, so the subject the manager grants and the subject the session publishes to
  cannot drift apart. A connector that does not implement it refuses `--events` before any provisioning
  rather than starting a session whose events have nowhere legal to land, and the refusal releases the
  name it had already reserved.

  **The flag and the grant are deliberately separate.** Holding publish rights on a channel is not a
  request to publish to it. An agent file or a manifest can hand-write anything into `allowPublish`, so
  if a grant could arm the plane, any author who could write an agent file could turn on a full
  transcript of another seat's tool inputs and outputs without ever touching the launch grammar. Only
  the launch arms the session; the grant is what makes the arming useful. `cotal_spawn`, the peer-facing
  tool, does not expose the option at all. That is the shape of the tool and not a control-plane refusal:
  the manager's spawn service op is a second door onto the same handler and still accepts the field,
  which is a pre-existing property of that door and is fenced separately.

  **The flag rides the whole launch path, including the record a restart reads.** It is on the
  foreground launch, the detached spawn payload, the manager service contract, and the resume document,
  so a manager restart brings an armed session back armed. The foreground path mints its own grant, from
  the principal it allocated, and passes the workspace root the emitter's write-ahead log needs: a
  session armed by one launch surface and not the other would be a flag that means two different
  things. A resume adopts the credential the spawn wrote rather than minting a new
  one, so what a restart can lose is the record: either the channel leaves `allowPublish`, or the
  arming flag does and the session returns holding publish rights it will never use, which reads as a
  working system with an empty panel. Both halves are now carried and both are asserted.

  **One behaviour change to state plainly.** The foreground launch now passes the mesh's root as the
  launch's workspace root, on every foreground spawn rather than only on an armed one, which is what the
  manager has always done. Two connectors already read that field and root their per-agent home at it:
  Codex, which puts its per-agent home under it, and OpenCode, which puts its database and its serve
  pidfile there. Both previously fell back to the directory the operator happened to run the command
  in. So a foreground Codex or OpenCode session moves its local state from that directory to the mesh
  root, which is where its detached counterpart has always put it. Operators who ran `cotal spawn` from
  somewhere other than the mesh root will find that session's state under the mesh root instead. The
  Claude connector reads the field only on an armed launch, and Hermes and pi do not read it at all.

  **Supporting pieces in the shared connector runtime.** The event vocabulary is exported from
  `@cotal-ai/connector-core` for the first time, so a connector can reach it by package name instead of
  by deep path. The emitter gained a way to close an open run out of band: a harness reports the end of
  a turn through a lifecycle hook that writes no record, so a record-sourced stream previously had no
  vehicle for a turn terminal. The closing frame is an ordinary frame with one exception, it republishes
  the source cursor unchanged, because advancing it would mark records consumed that were never mapped
  and leave a consumer no gap to notice it by. The emitter refuses to close while a message or a tool
  call is still open under the run, while a frame is still pending recovery, and after a halt.

  **One pre-existing limit this makes visible earlier.** In user mode the allocated actor is the display
  name, and principal tokens forbid `-`, which is reserved as the principal name form's separator. The
  manager's collision handling appends `-2`, so the second user-mode launch of any persona has never
  been principal-keyable; it already failed at the identity and provisioning sites. The event grant is
  derived before provisioning, so that launch now fails before it leaves a footprint rather than after.
  The underlying naming limit is unchanged and is not addressed here.

- 9c2412c: `cotal input --name <seat> --text <text> [--no-enter]` types one line into a running managed agent's terminal and returns, so a program can deliver a harness command (`/compact`, `/clear`, `/model`) without holding an `attach` stream open. It is backed by a new manager op `input`, which carries the same row shape and the same authorization as `attach` (capability `manager.lifecycle`, targeted, authz modes `owner` and `any`), takes `{text, enter?}` with the text verbatim up to 64KiB, and answers `{name, bytes}`. Enter is appended unless suppressed; nothing is echoed back. The manager's cluster document is revision 7, so a caller's `describe` sees the new command. `AgentHandle` gains an optional `write(data)`: the `pty` runtime implements it, and the external terminal runtimes (`tmux`, `cmux`, `orca`, `herdr`) do not own the child's input stream, so `input` refuses and names the runtime rather than dropping the keystroke. The command is granted only to operator credentials, in both modes, and NOT to the `spawn` capability that already carries `despawn` and `attach`. That placement is deliberate: an `attach` grant needs a `session-caller` credential to redeem and an agent profile cannot mint one, so `input` would be genuinely new authority rather than a restatement of `attach`, and the own-owner rule that bounds `despawn` covers every seat under an owner rather than only the ones a caller launched. Killing a peer is denial; typing into a peer is control of it. On a user-auth mesh `cotal input` therefore needs ledger scope `admin`, the scope `ps` already needs there.

### Patch Changes

- Updated dependencies [4cf5f72]
- Updated dependencies [219d33c]
- Updated dependencies [9c2412c]
  - @cotal-ai/core@0.21.0
  - @cotal-ai/workspace@0.21.0

## 0.20.1

### Patch Changes

- 2752fe7: Stop `cotal ps` waiting on registrations whose host is gone, and give those registrations an exit.

  A class scatter's gather has two exits: every frozen slot answered, or the deadline. The expected set
  is frozen from the service registry, which records registration rather than liveness, and an instance
  that crashes never deregisters, so its record goes on claiming a live instance for as long as the
  bucket exists. That leaves a slot which can never answer, which makes the first exit unreachable, so
  the deadline is paid in full on every scatter in the space, indefinitely. Measured on the laptop this
  was built against: `cotal ps` at 12.5s with one true corpse in the set, ending in a row that read
  `unreachable` for a machine that had been gone for weeks. There was no way to remove that record.
  Three things were wrong, one per layer, and all three are fixed here.

  **The scatter can now be told an instance is gone.** `epScatter` takes an optional `probeLiveness`
  hook and ends the gather once every frozen slot has either produced a valid reply or been affirmed
  gone. It moves the classification point and nothing else: an affirmed-gone slot is still `missing`,
  still surfaced, still not `complete`, and a straggler arriving after an early finish is still reported
  `late` rather than dropped. Only the verdict `gone` licenses anything; `live`, `unknown`, a hook that
  throws, and any value outside the closed set all leave the full deadline standing, so a broken probe
  degrades to exactly the previous behaviour rather than to a fast wrong answer. `epProbeInstanceInterest`
  supplies that verdict from the broker itself: a `describe` cast on the instance's own rail with the
  reserved no-responders sentinel as its reply-to, the same primitive and trust rule `epCall` already
  relies on. A serving incarnation subscribes its instance rail for every command it serves and every
  endpoint must serve `describe`, so silence on that rail is evidence of absence rather than absence of
  evidence. The reply is never read, so an instance whose describe is broken still reads as present.

  **And a probe is never a reason to still be running.** Against a live instance the probe is never
  answered, because the request is a cast and a responder must not reply to one, so its deadline timer
  runs the full budget on every healthy instance every time. Wired into `cotal ps` that was measured at
  four extra seconds after the last row was printed, on a mesh with no dead registration in it at all:
  12.8s with the probe against 8.8s with it switched off, same tree and same mesh. The timer is now
  unref'd, so a probe still settles `unknown` at its budget for anyone waiting on it and no longer holds
  the event loop open for a caller whose gather has already finished. The same measurement after the fix
  is 8.6s to 9.4s.

  **The probe belongs to the caller, not to the scatter.** Asking about an instance is a publish on that
  instance's rail, and a credential holding no row for it is refused by the broker asynchronously while
  the publish returns normally, so a refused probe is silent and silence is what a live but slow instance
  looks like. Core cannot tell those apart because core does not know what the credential carries. So
  `epScatterService` forwards a caller-supplied hook and never invents one, and the CLI supplies a closure
  that returns `unknown` without publishing for any id outside its pinned set, and reports a refusal the
  broker raises anyway instead of letting it expire into a timeout. That refusal is attributed to the
  instance its own subject names, parsed as an exact route token, so one refusal is never charged to a
  second frozen instance whose id happens to be a prefix of the refused one. `cotal ps` freezes the class on its
  first connection, re-mints an instrument pinned to exactly the frozen ids, and resolves and scatters on
  a second. `instancePinnedInstrumentCapabilities` accepts several ids as well as one; each still emits
  its own concrete rows, so no wildcard instance is minted and the existing boundary on instance
  addressing is unchanged.

  **A registration now has an exit, in two explicit routes.** A manager that stops cleanly deletes its own
  `svc` spec and status keys, so an instance that was shut down leaves no row behind; a manager that loses
  its lease still tears down fail-closed and deliberately does not deregister, because at that point it is
  not the authority on its own record. For the host that cannot cooperate, `cotal deregister-instance
--instance <id>` removes the record, on the same evidence the scatter acts on and no weaker: it asks the
  instance first and refuses if it answers, refuses if the probe could not run at all, refuses if the
  instance is merely quiet, and deletes both keys at the revisions it read only when the broker affirms
  that nothing is subscribed on that instance's own rail. Silence is never the evidence, because a wedged
  process still holds its subscriptions and an unanswered describe is what a dead host, a hung one and a
  slow one all look like. A dead process holds no subscription, so a real corpse still deletes. Nothing
  sweeps the registry on age or on silence. Registering over a deregistration tombstone now works on both
  keys, so a deregistered instance re-registers normally on its next start, with its epoch advancing.

  **Rows split by what was actually established.** A silent instance already printed as registered with
  no answer rather than as unreachable. Now that a probe exists, the four cases behind that one sentence
  are distinguished: a registration the broker affirms is gone says the registration is stale and prints
  the command that removes it, a probe that was refused and one that was never sent each say so, because
  both are facts about the command rather than about the instance, and asked-and-silent keeps the wording
  it has, since a slow host and a wedged one are the same observation.

  **And one layer down, the same shape.** The manager writes `.cotal/manager.pid` itself rather than
  having it written by whatever spawned it, so a supervisor started by a container entrypoint, by cron, or
  by hand is recorded like a detached `cotal up` is; the record is removed on a clean stop, and only while
  it still names that process. Every reader now verifies the recorded pid is alive and is a supervisor
  before trusting it, and a live pid that belongs to something else is reported as a stale record and
  never signalled.

  This does not help against an instance that is connected but not answering. A hung responder holds its
  subscriptions and is indistinguishable from a slow one, so it still costs the full deadline, which is
  the correct result, and the removal verb refuses it for the same reason rather than unregistering a
  process that is still running. A scatter with no probe wired behaves exactly as before.

- Updated dependencies [2752fe7]
  - @cotal-ai/core@0.20.1
  - @cotal-ai/workspace@0.20.1

## 0.20.0

### Patch Changes

- @cotal-ai/core@0.20.0
- @cotal-ai/workspace@0.20.0

## 0.19.0

### Patch Changes

- c038730: A manager lease renew that gets no answer no longer terminates the manager; the key is re-read
  first.

  `renewLease` treated every throw from the CAS renew as the lease being lost and fail-closed the
  whole instance: it cleared the renew timer, tore down every agent it managed, and exited. One of the
  things that throws there is a request that gets no answer within its deadline, and no answer proves
  nothing about the key. It does not prove the write failed, it does not prove the key expired, and it
  does not prove anyone else took it. The write may even have landed with only the acknowledgement
  lost, in which case the manager killed itself over a lease it had just successfully renewed, and
  took its agents with it.

  A failed renew is now a question rather than a verdict. The manager re-reads its own key, which
  separates "it is gone" from "I could not find out", and fails closed only on proof: the key is
  absent, or it is present and holds a different process. When the key is still its own the manager
  adopts whatever revision the broker actually has and keeps serving, saying so. When no answer is
  available at all the bound is time rather than attempts, because past one whole TTL without a renew
  that landed the key may have expired and been re-acquired, so the instance can no longer claim to
  hold it and stops on that ground, in those words.

  That window runs from the last write that actually restarted the key's TTL, and only such a write
  refills it. A re-read that finds the key present, still its own, and at the SAME revision is a real
  answer and the manager does keep serving on it, but it did not touch the key, so it cannot buy the
  holder more time. Reading a key is not refreshing it, and treating the two alike would let an
  instance whose writes are all being dropped serve on reads forever.

  Waiting is only safe if there is room to wait, so the renew budget gained slack. The TTL is
  unchanged and no stored config moves, but the holder now renews at a quarter of it rather than a
  half, and each attempt carries a deadline shorter than the period instead of the JetStream default,
  which was itself half the TTL. Under the old numbers exactly one attempt fitted inside the window
  and its own deadline consumed the remainder, so a single slow round trip was terminal by
  construction.

  Renews also no longer overlap. A renew whose reply is late runs past the next tick, since the
  re-read that follows it has a deadline of its own, and a second renew started there read the same
  cached revision and was refused over a sequence the first one had legitimately moved. That conflict
  was self-inflicted, and it reproduced on every attempt before the guard.

  Measured against a real manager process, with a relay between it and the broker holding back one
  direction for exactly one renew deadline: the request reaches the broker and takes effect, only the
  acknowledgement is delayed. On the old code the manager exited while its key was present, still its
  own, and carrying a revision newer than the one it was holding.

- Updated dependencies [48c6631]
- Updated dependencies [10d9cd6]
- Updated dependencies [a1bc784]
- Updated dependencies [a7267b3]
- Updated dependencies [ce1c248]
- Updated dependencies [5e95736]
- Updated dependencies [19931dd]
- Updated dependencies [6074c26]
- Updated dependencies [24687a3]
- Updated dependencies [17f14be]
- Updated dependencies [87c4130]
- Updated dependencies [cb9e1ad]
- Updated dependencies [c038730]
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [8572a5d]
  - @cotal-ai/core@0.19.0
  - @cotal-ai/workspace@0.19.0

## 0.18.0

### Minor Changes

- 0ab9b4d: Move the auth plane's retirement rail off the retired `ctl` surface onto the endpoint subjects

  The auth plane served its generic "retire a lifecycle" operation on
  `ctl.auth-admin.<owner>.<actor>`, a rail the spec retires in full and states must
  not be handled. Rows written onto a deleted rail are defects rather than
  exceptions to it, so the rail moves to
  `ep.one.auth.retire-lifecycle.handle.<target triple>.<caller triple>.<nonce>`
  instead of the cut growing a carve-out.

  Two things get stronger on the way. The reply is now derived from the parsed
  request, so there is no argument through which a caller- or payload-supplied
  reply target could arrive; and the request and reply planes are disjoint, so the
  listener credential cannot express a request subject at all. The per-despawn
  requester credential now pins both its caller triple and exactly one target
  incarnation, so a leaked requester cannot be re-aimed at another lifecycle.

  Serve-time authorization additionally requires that the serve registration a
  request names belongs to the requesting principal. The previous two-token
  subject could not express the caller beyond a recyclable alias, so the rail
  accepted any registered instance's registration. This is alias-level binding:
  the registration is keyed by an id that is stable across restarts and carries no
  lifecycle uid, so a same-principal predecessor presenting the current epoch is
  still accepted.

  The spec rows also described an authorization mechanism the implementation had
  already replaced, and now describe what ships.

  This is a subject-plane migration, not a completed endpoint migration. The rail
  carries the endpoint subjects but still exchanges the pre-v0.4 request and reply
  bodies, registers no service record, serves no `describe`, and has no contract
  artifact — so a generic endpoint client can neither discover nor invoke the
  command. That gap is tracked separately, with the acceptance test being that a
  generic client can do both. The one acceptance-path hole is closed here rather
  than deferred: the request carries an id, the reply echoes it, and a reply that
  does not echo is refused, so a wrong-id success cannot clear a retirement hold.

  The requester's grant pins its target with the `handle` mode, which is normatively
  redemption-minted. This path is not: there is no issuer-signed artifact, no
  redemption step, and no lineage — the row is built directly from the minting
  manager's coordinates under root authority. It is used because it is the only
  target mode that can pin an exact incarnation, and the serve-time handler
  re-checks that triple against the current mapping. This is a documented
  deviation, not compliant handle semantics, and it is stated at the mint site and
  in the ownership matrix row. It resolves with the same tracked work as the
  envelope, since the mode and the envelope are one wire-conformance surface.

- 208ad1f: Add a guarded way out of an issuance gate left frozen by a crashed manager restart.

  When a manager restart is killed between deregistration and the successor's completion, the
  endpoint's issuance gate is left frozen under a registration operation whose holder no longer
  exists. Failing closed there is correct — it is what stops two incarnations serving at once — but
  until now nothing could lift it, so every subsequent restart failed the same way and the only exits
  were driving the internals by hand or discarding state.

  `cotal reconcile-gate` verifies the freeze-holder is gone, logs what it found, and then completes
  the dead operation exactly as the interrupted restart would have: revoke the credential family,
  verify-evict its holders, and reopen the gate at the unchanged coordinate with the generation
  advanced by one. It is a CLI command rather than a verb on the manager endpoint because the state
  it repairs is precisely "the manager cannot complete registration" — an endpoint-served repair
  would be unreachable exactly when it is needed.

  The affirmative check required a read half that did not exist. The only principal-scoped liveness
  was fused with the KICK inside `evictPrincipal`, so using it as a precheck would have killed a live
  holder before anything could refuse on its behalf. This adds a read-only `principalLiveness`
  delivery-admin verb (observer credential only, closed query, a reply bound to the exact principal
  asked about) reporting `live` / `gone` / `unknown` with scan completeness kept separate. Its sweep
  is the strict one the plane-liveness oracle already used — full reply validation plus the
  single-server proof — now extracted and shared by both, so a probe can never be laxer than the
  repair it authorizes.

  Every refusal names its condition (`holder-alive`, `holder-unknown`, `liveness-unestablishable`,
  `not-frozen`, `wrong-op-kind`, `no-gate`, `eviction-unverified`, `raced`). A timeout is
  unknowability rather than death, the probe is a precondition on top of the barrier's own verified
  eviction rather than a replacement for it, and there is no force flag and no path that discards
  gate state.

  Two defects in the shared `$SYS` scan surface were found while proving this and are fixed here,
  because the guarded command is only as good as the observation it stands on.

  A paginated CONNZ sweep could read a **lost later page as sweep-complete**. The first page comes
  back full with more promised, the next round is silent or answers with an empty page while its own
  total still says there is more, and the loop treated that as the end of the data. Since "complete
  sweep, principal not found" is the definition of verified-gone, a connection living on the page that
  was never delivered read as absent — so verified eviction could report gone for a principal that was
  alive. Both the read-only observation and the scan/kick/re-scan primitive had the same shape, which
  also meant the two of them were not the independent checks they looked like. A sweep now tracks
  which servers still owe it a page and fails closed when one stops delivering; a sweep that genuinely
  finishes across several pages still concludes gone, so nothing wedges.

  The delivery daemon's `$SYS` sweeps were **not bound to the account it serves**. All three
  delivery-admin executors resolved their scan account from the working directory at request time, and
  the detached daemon inherits its launcher's directory for life — so a daemon started from a tree
  that resolves a different mesh root would sweep a foreign account and answer a confident, wrong
  "gone". The root is now pinned once at start, and the account read from disk is cross-checked
  against the account the daemon's own credential authenticates as.

- b519e73: Add the Herdr integration: a new `@cotal-ai/herdr` extension with a self-registering `herdr` Runtime provider that spawns managed agents into panes of a dedicated named Herdr session (`cotal-<space>`), where the Herdr server owns them — so they survive the manager's terminal going away. Requires herdr >= 0.8.0, enforced by a version check rather than a bare binary probe, so an older herdr reports the runtime as unavailable instead of advertising it and then failing every spawn.

  Each agent gets its own workspace and name-labeled tab by default (`COTAL_HERDR_LAYOUT=split` folds them into one shared tab). A spawn is `workspace create` + `pane run "exec …"`, then a bounded wait on the real process table — `pane run` types into a shell, so a delivered keystroke is not proof that anything started. The `exec` is load-bearing: without it the pane's shell outlives the agent and no exit could be proven. Lifecycle is keyed by Herdr's stable `terminal_id` with the public pane id re-resolved per operation off the session-wide pane inventory; creds ride an owner-only launcher script, never herdr's command line or its native `--env` (which lands in pane scrollback); every CLI call is scoped with `--session`.

  Spawned agents do not appear in Herdr's Agents sidebar: 0.8.0 reserves that registry for recognized agent kinds attached to an existing pane, so an arbitrary launcher is never one. They are identified by tab label and a `cotal` metadata token on the pane.

  The CLI lists `herdr` among the official runtimes (`cotal runtimes`, `cotal ext add @cotal-ai/herdr`), and CI now installs herdr so the extension's smoke suite actually gates rather than silently skipping.

### Patch Changes

- Updated dependencies [0ab9b4d]
- Updated dependencies [208ad1f]
- Updated dependencies [665b378]
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0
  - @cotal-ai/workspace@0.18.0

## 0.17.0

### Minor Changes

- 019afc3: The manager control surface gains three capabilities on the v0.4 endpoint rails: spawn as an action, multi-manager instance addressing, and attach as a mesh session.

  Spawn and launch are now actions (SPEC 13.6). Asking the manager for an agent no longer blocks the caller while the process comes up: the manager accepts a spawn goal and returns the allocated identity at once (`{name, owner, actor, uid, goalId, fingerprint, executor{lifecycleUid, epoch}}`), then progress events follow the launch to a terminal outcome. Presence within the readiness window settles the goal `succeeded`, an early exit `failed`, and the window elapsing with neither is `uncertain` (a bounded, durable outcome a later `ps` settles against the live roster, never a silent hang). A persona-derived name collision auto-numbers; a hard-pinned `--name` colliding with a live agent refuses at accept, before anything is minted. The `--detach` CLI spawn, the manifest `-f` launch, and the connector's `cotal_spawn` submit and follow to the terminal, so their behavior is unchanged. The goal terminal is fenced to the executing manager's own gate epoch (the terminal lands on an epoch-scoped result subject), so a superseded incarnation's terminal is invisible to current readers; a durable reconcile index lets a restarted manager settle any goal a predecessor accepted but never terminalized. The goal-fact writer is a dedicated, family-staged, renewed credential disjoint from the serve credential.

  One space can now run more than one manager. Each manager persists a stable logical instance id across restarts and advances its process epoch when it comes back, so peers address a specific manager regardless of which process currently serves it; a restart re-registers the same instance and evicts its predecessor's serve family through a scoped, one-registration eviction credential. `cotal spawn --on <instance>` pins one instance by its exact id, an untargeted spawn rides class anycast (the acceptance records which instance took it), and `cotal ps` / `status` become a class scatter that merges every registered instance's rows with per-instance attribution and labels a non-answering instance unreachable, never omitting it. The manager lease is demoted from a per-space singleton to per-instance liveness (loss stops only that instance's serving, never the space), reconcile touches only rows the instance owns, and the retirement rail authorizes on the registration gate rather than a name-derived holder, so a deposed predecessor cannot retire a target.

  `cotal attach` no longer returns a `127.0.0.1` websocket URL. It creates a one-use, holder-bound session over the mesh: the reply carries a signed session grant (no URL, never logged), redeemed once, after which terminal bytes stream on session subjects scoped to the two parties, with backpressure surfaced as an explicit drop notice. A late attach still repaints the full screen from a replayed terminal snapshot, and close, expiry, target despawn, and manager restart are distinct, surfaced end states. The browser console is now a real mesh session client over a served bundle (the broker gains a localhost-default websocket listener), holding only a per-session, rails-only credential that expires with the session. The manager's session writer is a scoped, family-staged, renewed credential over a dedicated sessions store.

- f85ffbf: The manager now registers itself as an ordinary v0.4 `service` endpoint (`manager`) on every static auth mesh and dual-serves its FULL typed command surface on the endpoint rails beside the existing control tiers — nothing removed yet. The served commands mirror every control op through the same handler cores: `status`, `ps`, `inspect` (per-agent read), `models`, `spawn` (the full 16-field launch surface), targeted owner-mode `despawn`/`attach`, the baseline self-mode `stop`, `define-persona`, `purge`, `launch`, the resume/preservation family, and the reserved `describe`. `ps`/`inspect`/`spawn` replies now also carry each agent's `lifecycleUid` (the coordinate a targeted request pins). Core gains the production endpoint-serve credential subsystem over the durable auth store: the §13.1 endpoint issuance gate and serve ledger (`epgate…`/`epcred…`), the registration barrier with fail-closed eviction, and the serve-mint release fence — plus a key-pinned one-shot `endpoint-serve-executor` credential profile scoped to exactly one endpoint instance's gate, serve-ledger family, and registration record keys. The manager drives its registration and every serve-credential mint and renewal through that scoped executor connection (never its standing supervisor connection), applies one shared lifecycle-membership + maintenance admission gate on both control doors (the legacy `ctl` tiers and the new endpoint rails), and renews its bounded serve credential on the standing renewal pass. Registration also publishes the manager's §13.7 contract artifacts — every command's schema root, its closure manifest, and the cluster document — to the per-space content-addressed contract store (created create-or-verify at manager start alongside the authority stores), and every agent credential's baseline now carries the store's read grant, so any caller can fetch, verify, and recompile the registered schema digests without out-of-band contract sharing.

  The control CONSUMERS now ride those rails (static-auth meshes): every CLI manager call (`spawn --detach`, `ps`, `stop`, `attach`, `models`, `down`/`up`'s resume and preservation phases) and every connector supervision tool (`cotal_spawn`/`cotal_despawn`/`cotal_persona`, self-stop, history purge) goes through the generic invoke path - describe, fetch the registered schemas from the contract store, recompile digest-verified validators, invoke - instead of hand-importing the manager's contracts; invoke currency is describe-bound (the answering incarnation's broker-authenticated identity), so a superseded or split-brain manager refuses instead of answering stale. New `cotal describe <endpoint>` and `cotal invoke <endpoint> <command>` expose the same generic surface to operators. Operator reach is now minted, not door-refined: `control-caller-privileged`/`control-caller-admin`/`deployer` instrument credentials carry tier-matched endpoint capability rows (the admin tier's cross-agent `despawn`/`attach` ride the operator-only `any` authorization mode, declared in the manager's revision-3 cluster document), the spawn capability additionally mints `define-persona` + `inspect`, and an `admin`-capability credential mirrors the full admin instrument set. Open meshes and user-mode bearers kept the legacy `ctl` path until the final slice below.

  User-mode meshes join the migration end to end: the manager registers its v0.4 service on per-user meshes too (the registration/serve machinery is operator infrastructure riding the space's static trust material), the CLI's bearer path derives its caller triple from the bearer's ledger lifecycle claim, the connector's endpoint identity is its triple in every auth mode (no ctl branch left in the connector), and `spawn -f`'s deploy probe drives `ps`/`launch` over the generic invoke path for both the static admin credential and the user-mode deployer view. Serve-side hardening: every `manager.admin`-class command (purge, launch, and the resume/preservation family) re-checks operator reach at serve time against the caller's CURRENT ledger scope on user meshes, so a revoked `admin` scope demotes the next call instead of riding out the bearer's remaining row lifetime.

  The migration is now complete: the manager's legacy `ctl` control rail is deleted. Core drops the `manager`/`self`/`admin` control tiers, the `ControlTier` type, and `controlSubject`; the server-side `ctl.delivery`/`ctl.delivery-admin`/`ctl.auth-admin` rails (the delivery daemon's and auth service's own carve-outs) are unchanged. Every credential profile is endpoint-only: agent baselines lose the `ctl.self` publish and control-reply subscribe rows, the supervisor serves no control tier, and the operator instruments carry endpoint capability rows only, so the old manager control subjects are unreachable end to end (publish rows, serve subscriptions, and handlers are all gone). The manager registers its `service` endpoint on EVERY mesh: auth meshes ride the scoped endpoint-serve executor; open meshes run the same gate/registration/serve-grant ceremony over bare one-shot connections (no credential is ever minted; the broker enforces nothing on an open mesh) and create-or-verify the authority stores at boot, so a raw broker no longer dies at the first gate write. The CLI's control layer replaces `ControlTier` with `ControlReach` (`owner`/`any`): the target's authorization mode derives from the resolved target owner (an own-domain target rides owner mode; a cross-owner target rides any mode, which the broker admits only for admin-instrument holders), open meshes ride a bare caller triple, and a raw `--creds` control caller without an endpoint caller identity refuses loud instead of falling back. `ps`/`inspect` rows pin `role` as optional (a manifest-launched agent declares none, and the reply schema previously failed the responder's own output).

- 9e13648: Static meshes now run the full §13.1 lifecycle for manager-spawned agents. Every static spawn reserves a never-reused lifecycle uid and activates a durable, principal-keyed registry head through the same shared activation saga user mode runs; a durable slot row maps the agent name to its incarnation (name reuse is serialized by the slot + the manager's hold, never by trust in the name). Despawn drives the full retirement barrier: the incarnation's ledgered credentials are revoked, its footprint is torn down inside the barrier, and the name frees only at the terminal. Manager-spawned static agent credentials are now bounded (24h TTL) and ledgered; the manager renews live agents' credentials ahead of expiry (a copied credential cannot renew and is refused at the manager's control surface once its lifecycle retires — the new live-membership gate authorizes control by the authenticated incarnation principal, never by name or credential tier alone). Crashed spawns and manager restarts reconcile from the durable registry, so no active orphan survives. `cotal up` now seeds the two authority stores on every auth mesh, and provisioning gains a key-pinned one-shot `lifecycle-executor` credential profile scoped to a single incarnation's registry keys. Unit A of the same slice makes agent secret files lifecycle-owned (`<name>.<uid>.creds`) with roster-aware name allocation, closing the despawn/respawn teardown race.
- 185e721: Renew the `$SYS` credentials without tearing the space down.

  `membership-observer.creds` and `connection-evictor.creds` carry a 30-day expiry and are signed by
  the system-account seed, which is never persisted, so nothing re-signs them in place. The only
  repair the tooling named was "`cotal down` then a fresh `cotal up`", and that did nothing: `up`
  mints the pair only on the branch that _creates_ the trust record, so re-upping a provisioned space
  reused the same expired files and reported success. A long-running mesh therefore lost its
  membership feed and live connection eviction every 30 days with no supported way back.

  `cotal up --rotate-sys` is that way back. It issues a new system account under the same broker
  operator, mints both `$SYS` creds against it, and renders the broker config from the rotated record,
  so the broker it starts is the one that trusts them. The data account, the account signing key,
  every agent credential minted from it and the JetStream store are untouched; what dies is the
  retired system account, on every broker that loads the rotated config. It is refused wherever the
  on-disk material and the broker could end up on different generations: a running mesh; an open mesh,
  whether that comes from `--open` or from `broker.auth: false` in a manifest; `--restore`; an
  unfinished restore or resume attempt on the root, including one a bare `cotal up` would recover,
  since those paths can adopt a live listener and return without booting a broker; and a root hosting
  more than one space, because the system account lives in the shared broker record and the rotation is
  therefore broker-wide. `rotateSystemCreds` is exported from `@cotal-ai/workspace` and carries the
  multi-tenant guard itself rather than at the CLI flag. It is deliberately a workstation operation and
  takes no `SecretStore`: the `$SYS` pair has no store seam to be written through, and because a
  `SecretStore` cannot be enumerated, accepting one would mean a broker-wide guard that reads a local
  filesystem while enforcing nothing for the tenants actually at risk.

  A rotation requires every broker for the root to be stopped, and three checks now say so: this root's
  recorded mesh at the requested address, anything unidentified answering there (which refuses instead
  of relocating to a free port), and the root's own ownership records: a live or unreadable `nats.pid`,
  or any recorded mesh for this root still reachable. Without them a lost registry row, or a
  `nats-server` started by hand against this root's `server.conf`, was enough to bypass the running-mesh
  refusal: `up` found the port busy, picked a free one, rotated, and left the old broker serving the
  retired config while a second one ran against the same JetStream store. These are Cotal's ownership
  records rather than a scan of the process table, and the docs say so: a hand-started broker on a
  different port writes none of them and is the named residual.

  Two consequences the tooling now states rather than leaving to be discovered. The retirement is
  config-load-bound, so a stale broker still running the previous config keeps honouring the old creds
  until it is stopped. And a full backup binds to the trust chain it was taken against, which includes
  the operator JWT and the system account, so every full artifact taken before a rotation refuses to
  restore afterwards: the rotation says so as it happens, and `cotal up --restore` names the drift when
  the data account still matches. The commit is a trust-record write plus two credential writes, so an
  interrupted rotation leaves the record ahead of the creds; that split is detected rather than
  silent. One shared check compares each `$SYS` cred's issuer against the persisted record, and it
  runs on every auth-mesh boot as well as in `cotal doctor auth`, so the state cannot pass unremarked
  by a mesh that simply never runs the doctor. The boot REFUSES rather than warning: a warning becomes an unread log line
  under `--detach`'s success output, and live connection eviction rides the same credential pair, so
  booting would silently downgrade revocation to deny-new for the life of the mesh. The delivery daemon, which never
  loads the signer and so cannot read the record, compares the two creds against each other instead.

  The recovery is covered end-to-end as well as in unit form: a suite drives the packaged binary
  against a real broker, a real delivery daemon and a real manager, on a root whose `$SYS` pair is
  already past its horizon. It asserts the reported symptom (the daemon's membership feed does not
  start, and says which credential and which repair), that `down` + a plain `up` leaves both files
  byte-identical and the doctor red, and that `down` + `up --rotate-sys` clears it in the daemon that
  reported it. The survival claim is checked rather than asserted: an agent credential minted before
  the rotation still connects afterwards, the CHAT stream returns at the same sequence and count, and
  registry state written before the rotation reads back through the CLI after it.

  Diagnosis now names the cause instead of the symptom. An expired observer cred used to surface as a
  bare "Authorization Violation" in the delivery log and, one layer up, as a `membership-rw` adoption
  refused with "membership feed is not running", neither of which mentions a credential. The daemon
  checks the observer's own expiry before connecting and reports it, carries that reason into the
  adoption reply, and the manager warns on every renewal pass from the 75% point onward rather than
  letting the mesh discover the expiry at the horizon. `cotal doctor auth`, `evictPrincipal`,
  `planeConnLiveness` and the two mint errors now print the repair that works. Where the feed is down
  because its bundle is incomplete rather than expired, the daemon now names the missing files and
  distinguishes the two cases: a missing `$SYS` observer is re-minted by a rotation, while a space
  predating broker-sourced membership is missing the rw cred and the account id as well, which a
  rotation does not write, so it is told the truth rather than sent through a stop/start that cannot
  help it.

### Patch Changes

- 463d597: Derive the right to settle a goal from winning its claim, instead of tracking it with a flag.

  `serveSpawnGoal` used one boolean, `terminalEntered`, to answer two different questions: has this
  goal already been settled, and may this attempt settle it. The second is an authority question and
  the flag defaults to the permissive value, so every way of leaving the accept path was opted **into**
  committing a terminal unless someone remembered to claim it by hand. That is how a duplicate-goal
  loser came to commit `failed` on the winner's goal (#357), and the fix for it had to add two more
  hand-placed claims, which is the same shape again.

  An attempt now earns `ownsGoal` by winning the create-only `bindGoal` CAS, and the single commit path
  refuses anything else. Both loser branches drop their hand-placed claims: a losing attempt cannot
  commit down any unwind path, including ones added later that never considered this.

  `terminalEntered` keeps its own job, which is stopping a second settle behind a despawn that owns the
  outcome.

  This also closes a coverage gap rather than arguing it away. The sibling-instance branch (a foreign
  manager already recorded the goal) previously needed its own guard, and mutation-testing that guard
  killed no check because the duplicate-goal test races a single manager. There is now one enforced
  check covering both branches, and removing it reddens that test: 33 passed / 2 failed, the same two
  cells, as predicted before running.

  The sibling route is also driven directly now, by a new suite `smoke:goal-sibling-race`: two managers
  in one space, one request frame delivered to both, with A's goal deliberately left in flight so a
  stolen terminal has something to destroy. Removing the fence makes B commit `failed` on A's goal,
  and the recorded committer is B's instance id while the message names A's, which is what makes the
  attribution unambiguous.

- 9093440: A duplicate-goal loser no longer steals the winner's terminal.

  When two same-goalId attempts race, the loser of the create-only `bindGoal` CAS serves the winner's
  acceptance and unwinds. That unwind reached the post-accept fallback with `terminalEntered` still
  false, so the loser committed a `failed` terminal carrying its own abort message as the outcome.

  The loser fails in one CAS round trip while the winner is still minting credentials, spawning a
  process and waiting for readiness, so the loser's failure normally lands first. First-terminal-fact
  wins, so it becomes durable and the winner's real `succeeded` loses the CAS. The caller reads a
  failed goal for an agent that started fine. Two side effects rode along: the loser cleared the
  reconcile index entry that would otherwise let a successor settle the goal honestly, and dropped the
  winner's cancel path.

  The losing attempt now claims the terminal without committing one, the same thing
  `onTerminalDeferred` does for a despawn that owns the outcome. It provisioned nothing, so it settles
  nothing.

  Reproduced before the fix, on a real broker with a real manager and a real agent process, by
  capturing a spawn request off the wire and replaying the identical frame. The committed terminal was
  `failed` with the loser's abort text. Covered by a new `M8` case in `smoke:manager-spawn-action`,
  which carries a positive control asserting the duplicate actually reached the wire, since a replay
  that silently never fires would make the whole case vacuously green.

  The same claim is applied to the sibling-instance branch (a foreign instance already recorded the
  goal index). That line is reasoned by symmetry and is **not** covered: mutation-testing it kills no
  check, because the new case races one incarnation. A multi-instance race test would be needed to
  prove it.

- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [2768f5b]
- Updated dependencies [019afc3]
- Updated dependencies [3539f20]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [14ff831]
- Updated dependencies [11cd652]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0
  - @cotal-ai/workspace@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [531d37d]
- Updated dependencies [498055c]
  - @cotal-ai/workspace@0.16.0
  - @cotal-ai/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f89560a]
  - @cotal-ai/core@0.15.0
  - @cotal-ai/workspace@0.15.0

## 0.14.11

### Patch Changes

- @cotal-ai/core@0.14.11
- @cotal-ai/workspace@0.14.11

## 0.14.10

### Patch Changes

- @cotal-ai/core@0.14.10
- @cotal-ai/workspace@0.14.10

## 0.14.9

### Patch Changes

- c88ef4c: `cotal spawn -f` now deploys to a remote manager: when the mesh's serving manager lives in another checkout or on another host, the resolved launch spec rides the `launch` control op inline — the manager validates it with the same untrusted-input contract as the file path and persists it under its own `.cotal/run/` (stale-restart and retained resume read one source either way). The ledger stays with the deploying checkout, so `down -f` works from there too. Also fixes a pre-existing re-apply edge: the transient persona file is now written atomic-replace instead of exclusive-create, so re-launching an agent after a partial deploy failure no longer dies on EEXIST.
- Updated dependencies [a4c082a]
  - @cotal-ai/workspace@0.14.9
  - @cotal-ai/core@0.14.9

## 0.14.8

### Patch Changes

- 84f6200: Per-agent `prompt:` in the mesh manifest — a kickoff message auto-submitted once the session is up, the declarative form of `cotal spawn --prompt`. Submitted on first boot and on stale-restart (hash-covered, so changing it marks a running agent stale); a reclaim of a still-live session does not re-submit. Imperative `--prompt` alongside a manifest launch is still rejected (one source). `topology view` marks agents that carry one.
- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8
  - @cotal-ai/workspace@0.14.8

## 0.14.7

### Patch Changes

- 12ad5e3: Close two attach defects: a capability issued for the wrong agent, and remote attach silently dying after a manager repair.

  **An attach capability could be issued for an incarnation nobody authorized.** `opAttach` resolved the
  agent name, awaited authorization — which on a user mesh performs a ledger read, a real async
  boundary — and then asked for a ticket by NAME. Ticket issuance re-resolved that name and bound
  whichever agent held the slot at that moment. A stop and same-name respawn landing inside the await
  therefore authorized one incarnation and handed out a valid terminal capability for its successor,
  which on a user-auth mesh can belong to a different owner. `url()` now requires the authorized handle
  and refuses when the slot has moved under it, and `opAttach` re-asserts the incarnation immediately
  after the await so the non-pty path shares the invariant. This is the same class as the name-binding
  fix in 0.14.4, one step earlier in the sequence: that closed the window at redemption, this closes it
  at issuance.

  **A manager replacement quietly demoted attach to loopback.** The bind host for the manager's
  attach/console face was passed only on the first `cotal up` and never recorded, so every later launch
  for the same mesh fell back to loopback: a same-root repair, adopting a preserved or restored
  listener, and a `spawn -f` manifest deploy. The broker, the agents, and the mesh all stayed up, so the
  only symptom was `cotal attach` failing to connect from another machine. It is not derivable after
  the fact — a broker dial address is deliberately not treated as a manager bind address — so the
  decision is now recorded on the mesh entry and read back by every manager launch. An explicit
  `--host` still wins, and a mesh that never asked for exposure records nothing and stays loopback-only.

  Also narrows `.cotal/manager.log` to 0600 (new and existing), since the manager's console URL is
  written there and that URL carries a credential reaching every agent's terminal.

- Updated dependencies [12ad5e3]
  - @cotal-ai/workspace@0.14.7
  - @cotal-ai/core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- 1a1c4e1: Bind an attach capability to the agent incarnation, not the reusable name.

  0.14.4 made attach capabilities single-use, short-lived tickets bound to the one agent name the
  manager had just authorized. A name, however, is a reusable slot rather than an identity: if the
  authorized agent exits and a same-name successor takes that slot within the ticket's two-minute
  lifetime, the untouched URL would attach the successor's terminal. On a per-user-auth mesh that
  successor can belong to a different owner, which turns it into a cross-owner terminal handover, the
  same class of boundary failure the ticket was introduced to close.

  A ticket is now bound to the agent _handle_ it was issued against. The manager creates a new handle
  per spawn, so a successor can never compare equal to its predecessor, and redemption re-resolves the
  name and requires the same incarnation. Issuing a capability for an agent that is not running is now
  a loud error rather than a ticket that quietly never redeems.

  Covered by two added checks in `smoke:attach-auth` (40 total): a ticket is refused once a same-name
  successor occupies the slot, and `url()` refuses to issue for an unknown agent.

  - @cotal-ai/core@0.14.5
  - @cotal-ai/workspace@0.14.5

## 0.14.4

### Patch Changes

- eccf48c: Make `cotal attach` reach a manager on another machine, and credential that endpoint properly.

  The manager's attach face bound a hardcoded `127.0.0.1` and advertised that same literal in the URL
  it handed back over the control plane, so a remote operator dialed their own loopback and got
  `ECONNREFUSED`. Attach only ever worked when the manager happened to be on the same box.

  **Where it binds is now an explicit decision.** The endpoint takes a bind address, still loopback by
  default, so a bare `cotal supervise` and an embedded `Manager` keep exactly the machine-local
  endpoint they have always had. `cotal up` passes the address it bound the broker to (via a new
  `supervise --console-host`), which is what makes a remote attach work. The broker's _dial_ address is
  deliberately not reused as the _bind_ address: a manager may supervise a broker on another host and
  cannot bind that address at all, and a failover list's first entry need not be the server actually
  selected. Where the manager can only name loopback — a wildcard bind — the client substitutes the
  broker address its own control connection reached, so `up --host 0.0.0.0` works too instead of
  silently handing back an unreachable URL.

  **The endpoint is now credentialed, in two tiers.** It carries terminal read and write for every
  managed agent, plus the managed roster and the live mesh feed, so once it can leave the machine
  "unauthenticated but loopback-only" stops being a safe position. A mesh caller receives a **ticket**
  bound to the one agent the manager just authorized, single-use and short-lived; this is what makes
  the existing per-agent owner/admin check real, since a manager-wide token would let a caller
  legitimately authorized for its own agent swap the path and take over another owner's terminal. The
  **console token** is the operator's own, reaches every agent because the console drives all of them,
  and is printed solely to the manager's own output. The roster, feed, and PTY stream answer `401`
  without a credential; the static console shell stays open, since it describes no agent.

  Credentials never ride a cookie: cookies are host-scoped rather than port-scoped, so one set here
  would be sent to every other HTTP service on the same host and would collide between two managers on
  one box. The console URL carries its token in the fragment, which a browser never sends to a server,
  and the console page is served `no-store` with `Referrer-Policy: no-referrer`.

  Also fixes an IPv6 regression in the same area: `URL.hostname` returns an IPv6 literal bracketed
  (`[::1]`), which `listen()` treats as a DNS name and fails `ENOTFOUND`. Brackets are stripped for the
  bind and restored for the advertised URL. An address this host does not own now fails with the
  address named and the resolutions spelled out, rather than a bare errno from deep inside startup.

  Covered by a new `smoke:attach-auth` in the CI gate (38 checks), including the cross-agent path-swap
  that the first design allowed.

  - @cotal-ai/core@0.14.4
  - @cotal-ai/workspace@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [fce3199]
  - @cotal-ai/workspace@0.14.3
  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- @cotal-ai/core@0.14.2
- @cotal-ai/workspace@0.14.2

## 0.14.1

### Patch Changes

- @cotal-ai/core@0.14.1
- @cotal-ai/workspace@0.14.1

## 0.14.0

### Minor Changes

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

### Patch Changes

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/core@0.14.0
  - @cotal-ai/workspace@0.14.0

## 0.13.2

### Patch Changes

- c3afdaa: fix(renewal): prove the broker accepted a re-signed daemon credential before reporting it adopted

  `cotal doctor auth` could report a renewal "adopted" that the broker never accepted (a false green). The daemon's credential-reload path now proves acceptance on a disposable preflight connection before it adopts, and the record + `doctor` verdict only ever claim what was proven:

  - The delivery-admin `reloadCreds` reply narrows to `brokerAccepted` (identity/iat/exp actually accepted) plus a best-effort `residentSwap`, never an unwitnessed "adopted".
  - The passive 75% renewal timer and the explicit reload share one single-flight transaction and both preflight before installing a candidate, so a rejected credential in the store can never strand the live connection.
  - The whole daemon-side transaction is deadline-bounded (under the manager's request bound) with a late-commit fence, so a hung store fails loud instead of a silent "no responder".
  - `cotal doctor auth` now exits non-zero and says so when the last renewal was refused by the broker, instead of letting cred-file health alone stand as healthy.
  - The ephemeral generation fingerprint used to bind the expected generation is redacted at the persistence boundary, so it never lands in `.cotal/renewal.json` or logs.

- 2ed747d: feat(secret-store): migrate the membership feed's rw credential onto the store seam with proven standing renewal

  The broker-sourced graph feed's data-account (rw) credential now moves as a full read/write/delete kind through the `SecretStore` seam, so a hosted composition can renew it end-to-end (KMS/Vault) the way `delivery.creds` already does. Local `cotal up` is byte-for-byte unchanged (the default is the workstation FS store).

  - The feed's rw connection adopts credentials the way the endpoint does: an async source read outside the (synchronous) authenticator, a preflight-proven cache, a 75%-of-lifetime renewal timer, and a single-flight transaction bounded by an absolute deadline. Its authenticator now only ever presents the last **broker-proven** credential, so an incidental reconnect can no longer present an unproven or broker-refused generation and strand the feed.
  - The renewal owner (the manager) and the daemon now share one `SecretStore`: `Manager` takes an optional `secretStore` (defaulting to the workstation FS store) that feeds `remintDaemonCreds` and every per-agent secret kind, and `startMembership` reads the rw credential through the injected store. A hosted composition that hands the manager and the delivery daemon the same store renews both daemon kinds without a restart.
  - `cotal up` writes, and `cotal clean all` deletes, `membership-rw.creds` through the seam (never a raw filesystem write/remove), matching the `delivery.creds` discipline.
  - `credsRenewalDelayMs` (the 75% renew-early convention) is shared from `identity` so the endpoint and the feed compute it identically.

- Updated dependencies [c3afdaa]
- Updated dependencies [2ed747d]
- Updated dependencies [9625ec6]
- Updated dependencies [6960658]
  - @cotal-ai/core@0.13.2
  - @cotal-ai/workspace@0.13.2

## 0.13.1

### Patch Changes

- @cotal-ai/core@0.13.1
- @cotal-ai/workspace@0.13.1

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

### Patch Changes

- Updated dependencies [5491661]
  - @cotal-ai/core@0.13.0
  - @cotal-ai/workspace@0.13.0

## 0.12.0

### Patch Changes

- be66729: Add offline full-space and registry-only backup, preservation cuts, authenticated operation-isolated
  restore, conservative checkpoint recreation, same-principal resume, and explicit fallback cleanup.
  Remove the incomplete channel export surface.
- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.
- Updated dependencies [be66729]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/core@0.12.0
  - @cotal-ai/workspace@0.12.0

## 0.11.6

### Patch Changes

- Updated dependencies [7b24953]
  - @cotal-ai/workspace@0.11.6
  - @cotal-ai/core@0.11.6

## 0.11.5

### Patch Changes

- @cotal-ai/core@0.11.5
- @cotal-ai/workspace@0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4
  - @cotal-ai/workspace@0.11.4

## 0.11.3

### Patch Changes

- @cotal-ai/core@0.11.3
- @cotal-ai/workspace@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/core@0.11.2
- @cotal-ai/workspace@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [5b2863a]
  - @cotal-ai/workspace@0.11.1
  - @cotal-ai/core@0.11.1

## 0.11.0

### Minor Changes

- 9061d0e: feat: per-user authentication (owner+actor identity, IdP login, credential death)

  Add per-user auth as a first-class mesh mode. A mesh brought up with `cotal up --user-auth --idp <url>`
  authenticates humans against an identity provider and issues short-lived, ledger-scoped bearers through an
  auth callout, in place of long-lived static credential files.

  - **owner+actor identity.** An instance's wire identity becomes the two-token principal `(owner, actor)`:
    every subject carries the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id`
    re-key onto the pair. Cross-owner and same-owner cross-actor forge/read isolation is enforced by the
    broker; the connection nkey survives only as the transport credential.
  - **Login and delegation.** Humans sign in with `cotal login --idp <url>` (device-code); operators grant
    access with `cotal actor grant`. Agents are spawned under the signed-in human as managed `(owner, actor)`
    children whose scope is a subset of the spawner's (the delegation envelope rule). Agent identities live in
    a separate managed-actor ledger space, exchanged via their own per-agent secret, so they outlive the
    human's login session.
  - **Credential death.** Every managed credential is now lifetime-bounded, with supervisor and delivery
    standing renewal, `$SYS` rotation-renewal, live connection eviction on revoke, and a `cotal doctor auth`
    repair surface. On a user-auth mesh, static agent creds are retired (the flip): revocation closes the live
    window at the next connect.
  - **Elevated operator surfaces.** `cotal web`, `console`, `history clear`, `channels set/default`, and
    `spawn -f` come online in user mode via server-authored elevated view bearers, minted only by the
    signed-in human exchange and gated on ledger scope (`admin` / `spawn`); `ps` and `status` are
    owner-domain scoped.
  - **Connectors.** Add the `cotal_docs` tool (version-exact Cotal docs the agent reads natively) and an
    opaque `launchOptions` raw passthrough for the Claude Code, OpenCode, and Hermes adapters.

### Patch Changes

- Updated dependencies [9061d0e]
  - @cotal-ai/core@0.11.0
  - @cotal-ai/workspace@0.11.0

## 0.10.1

### Patch Changes

- e3a53e3: Add a connector-agnostic model/variant selector: the `cotal models` command, a `--variant` flag on spawn, and the core `listModels` / `ModelCatalog` + `LaunchOpts.variant` contract. OpenCode discovers its models and variants from the installed CLI; Claude and Hermes reject variants (fail loud) and set `COTAL_MODEL` when a model is given.
- Updated dependencies [e3a53e3]
  - @cotal-ai/core@0.10.1
  - @cotal-ai/workspace@0.10.1

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.

### Patch Changes

- Updated dependencies [6c40280]
  - @cotal-ai/core@0.10.0
  - @cotal-ai/workspace@0.10.0

## 0.9.1

### Patch Changes

- 14510c3: Manager detached-launch hardening (#159 Part B). A detached launch now reports
  `started` only when the agent actually joins the mesh (presence-based readiness);
  a dead-on-arrival launch surfaces as a failure with its tail output instead of a
  false success, and a launch that neither joins nor exits within the backstop is
  reported as uncertain rather than assumed up. On exit — despawn, crash, shutdown,
  or lease loss — the manager deprovisions the agent's minted broker footprint (its
  `dm_`/`dlv_` durables and ACL row) through a new target-pinned, least-privilege
  `deprovisioner` profile, so exited agents no longer leave durable litter behind.
- Updated dependencies [14510c3]
  - @cotal-ai/core@0.9.1
  - @cotal-ai/workspace@0.9.1

## 0.9.0

### Minor Changes

- 1bcc154: feat: manager least-privilege — no allow-all credential — plus session resume

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — the message
  schema is unchanged and `protocolVersion` stays `0.2`; this release is about who the manager is
  allowed to be on the broker, plus a new way to bring an existing session into the mesh.

  **Security — the manager is no longer an all-powerful credential**

  Until now every manager action ran under a single, blanket `manager` credential that could do almost
  anything on the broker — read any DM, tamper with any stream, publish as any agent. That credential
  is **gone**. Manager work now runs under a set of small, purpose-built credentials, each able to do
  only its own job and nothing else:

  - The **always-on supervisor** can serve control requests, hold its lease, and publish presence — but
    it **cannot read anyone's messages, create arbitrary consumers, or delete/purge streams**.
  - **Spawning, teardown, and history-purge** each run on their own short-lived, tightly scoped
    credential that exists only for that operation.
  - The **CLI verbs** (`send`, `spawn`, `channels`, `up`, `join`, `down -f`, …) each connect as the
    least-privileged profile for the job — an operator posts only as itself and can never forge another
    agent.

  The practical effect: a leaked or compromised manager credential can no longer read message bodies or
  meddle with other agents' streams — the blast radius is contained to exactly what that one credential
  was scoped to. Control replies are bounded per caller, `cotal join` now self-provisions its own inbox
  (no more `ConsumerNotFound` on a fresh console), and `cotal down` tears down all of a space's streams
  and buckets rather than a subset.

  **New — resume an existing session into the mesh**

  `cotal spawn --resume <id>` and `cotal start --resume <id>` fork an existing `claude` session — its
  deep context and long transcript — into the mesh, instead of always starting an agent from scratch.
  It **forks, never hijacks**: the meshed agent gets a _new_ session branched off that transcript, and
  the original is left untouched. Connectors that can't support this (`opencode`, `hermes`) are
  **rejected up front, before any provisioning**, with a clear error rather than a half-provisioned
  space.

  **Fixes & UX**

  - **`cotal attach` shows the real screen on (re)attach to a full-screen agent.** Re-attaching, or
    attaching late, now reconstructs and repaints the agent's current screen instead of leaving you on
    a blank or partial one.
  - **Mouse-wheel scrolling works in full-screen agents over `cotal attach`.**
  - **The `pty` runtime fails loud under Bun.** It isn't supported there, so it now says so clearly
    instead of misbehaving silently.
  - **Removed the `face:` viewer that had leaked from the frontier-faces example into shared connector
    code**, so an OpenCode persona with a `face:` field boots normally. Face rendering lives entirely
    in `examples/04-frontier-faces`.

  **Migration — re-`up` spaces created before this release**

  The supervisor now records its lease in a per-space manager bucket that older spaces don't have. A
  space that was brought up on an earlier version must be re-`up`'d (a fresh `cotal up` is fine);
  otherwise the supervisor throws `stream not found` on its first lease write. Nothing on the message
  wire changed, so running agents and clients are otherwise unaffected.

### Patch Changes

- Updated dependencies [1bcc154]
  - @cotal-ai/core@0.9.0
  - @cotal-ai/workspace@0.9.0

## 0.8.3

### Patch Changes

- a10ed79: OpenCode connector: mirror each agent's session transcript to its per-agent `tr-<name>` channel, event-driven from the plugin's in-process bus events (`message.updated` / `message.part.updated` / `session.idle`) — parity with the Claude connector, with no per-turn session refetch. The `tr-<name>` channel convention is exposed through the `Connector` contract (`Connector.transcriptChannel`) so the manager can grant the agent's publish ACL without the channel literal living in `@cotal-ai/core`, and the manager forwards control-plane `capabilities` (`COTAL_CAPABILITIES`) so a manifest-spawned agent exposes the `cotal_spawn` / `cotal_persona` tools its creds already authorize. Adds an end-to-end smoke for the mirror (`smoke:opencode-transcript`).
- Updated dependencies [a10ed79]
  - @cotal-ai/core@0.8.3
  - @cotal-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- @cotal-ai/core@0.8.2
- @cotal-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [15fb826]
  - @cotal-ai/core@0.8.1
  - @cotal-ai/workspace@0.8.1

## 0.8.0

### Minor Changes

- cce0a6a: feat: mesh manifests, the tmux runtime, and a new `@cotal-ai/workspace` layer

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays `0.2`; this release is all tooling, packaging, and hardening. The new publishable
  `@cotal-ai/workspace` package joins the lockstep group.

  **New**

  - **Mesh manifests — describe and launch a whole topology from one `cotal.yaml` (`kind: Mesh`).**
    The file is organized by channel (each lists `subscribe`/`allowSubscribe`/`allowPublish` —
    Cotal's native verbs, holding agent names); a top `agents:` table resolves each name to a persona
    (bare path / file + overrides / fully inline) and a connector (`agent:`, per-agent or a top-level
    default — no silent default). Under `personaPermissions: include` a persona's own channel grants are
    inherited for channels the manifest doesn't declare.

    - `cotal up -f <cotal.yaml>` brings up a **fresh** mesh — broker + seeded channels + booted agents —
      and owns the whole space (`cotal down` tears it down). A broker already reachable at the
      manifest's address is refused with a redirect to `spawn -f`, never re-seeded as fresh.
    - `cotal spawn -f <cotal.yaml>` deploys a manifest **additively** onto a mesh that's already
      running: brand-new channels are seeded and owned, already-present ones are left untouched
      (`exists-unmanaged`), and exactly what it created is written to a creation-only ledger
      (`.cotal/manifests/<runId>.json`). A re-declared agent whose policy changed is **stale** and
      exits non-zero unless `--allow-stale <names>`; unmanaged actors with access to a declared channel
      are surfaced as a SECURITY warning.
    - `cotal down -f <cotal.yaml>` (or `--run <id>`) tears down **only** what a `spawn -f` run created —
      never foreign actors on the shared mesh. The ledger is treated as untrusted input and validated
      whole before any deletion; an owned agent is stopped only when its recorded name **and** id match
      the live one, cred paths are derived from the auth root and deleted without following symlinks,
      and an owned channel is removed only when no other members remain. Local-only: same checkout/host
      that created the run.
    - `cotal topology view -f <cotal.yaml>` validates a manifest and renders its access graph
      (per-channel and per-agent subscribe/read/post, persona-inherited scopes, warnings) — read-only,
      no broker needed. `--dry-run` previews `up -f`/`spawn -f` and mutates nothing.

    Resolved agents boot via a transient, non-authoritative launch artifact under `.cotal/run/` (no
    generated personas in `.cotal/agents/`), handed to the manager through a new **operator-only**
    `launch` control op that reads the run spec by id, never an arbitrary path.

  - **`@cotal-ai/tmux` — a tmux Runtime and `TerminalLayout` extension.** Each agent spawned via
    `--runtime tmux` gets its own window in a shared per-space tmux session, with P3 `env -i`
    isolation; a `TerminalLayout` provider lets `cotal setup` open and close tmux windows from the
    ambient `$TMUX` session. Self-registers on import (`import "@cotal-ai/tmux"`), exactly like
    `@cotal-ai/cmux`. `cotal setup` now offers a tmux demo when run inside a tmux session.

  - **Web graph — hide offline members by default**, with a toggle to show them. Backed by
    broker-sourced authoritative channel membership.

  **Architecture**

  - **New `@cotal-ai/workspace` package — the machine-local workstation layer, split out of
    `@cotal-ai/core`.** Core is now strictly the wire standard (endpoint, subjects, message types,
    extension contracts) and depends on nothing else in the repo; the `~/.cotal` mesh registry, target
    resolution, preflight, `.cotal/` auth-path I/O, and the `cotal …` command-copy renderer now live in
    `@cotal-ai/workspace`. Dependencies flow one way:
    `examples → implementations → workspace → core ← (peer) extensions`. A `smoke:core-boundary` guard
    (in `pnpm check` and CI) fails the build if core ever imports workspace.

    **Migration (importers only — no runtime/wire change):** `mesh-registry`, `mesh-target`,
    `preflight`, and the auth-path helpers (`authDir`/`findCotalRoot`/`loadSpaceAuth`/`saveSpaceAuth`)
    now import from `@cotal-ai/workspace` instead of `@cotal-ai/core`. Mesh-target failures throw a
    typed `MeshTargetError` (with a `code` and structured `details`); detect it with the exported
    `isWorkspaceTargetError(e)` guard rather than `instanceof`. The `cotal …`-flavored error copy is
    rendered through a single `renderWorkspaceError(...)` over a `target | preflight | reachable`
    union.

  - **`cotal ps` / `start` / `stop` / `attach` now resolve their broker from the mesh registry** — the
    same way `send` / `channels` / `console` / `web` and the manifest verbs already do — instead of
    silently defaulting to `nats://127.0.0.1:4222`. `--space <name>` finds the recorded broker (and
    mints the privileged `manager` cred from that mesh's own recorded root); `--server` stays an
    override and `--creds` a raw off-registry escape hatch. The shared mesh-target preflight is now
    used by both the transient commands and the manager control commands.

  **Fixes & hardening**

  - **Manager forwards the resolved channel ACL to spawned connectors**, so a manifest-spawned agent
    actually subscribes to the channels its persona grants (no missing `COTAL_SUBSCRIBE`).
  - **Never prune a recorded mesh on an explicit `--server` override** — an off-registry target no
    longer evicts the registry entry it didn't come from.
  - **Web graph correctness** — mode chips filter persistent edges (not just animation), hidden nodes
    stay hidden under the visibility filters, and dashboard assets are served with
    `cache-control: no-cache` so the UI doesn't get pinned to a stale build.
  - **`cotal attach` restores terminal modes on detach** — focus-reporting is reset and stdout writes
    are guarded against a dead pipe, so detaching no longer leaves the terminal in a wedged state.
  - **Security hardening** — symlink-safe run directories, launch-policy re-validation at spawn,
    tightened launch-spec validation, and the operator-only manager `launch` op (above).
  - **CI** — the security/protocol smoke suite (`smoke:ci`) and the mesh-resolution / spawn-from-anywhere
    / core-boundary smokes are gated in the `check` workflow.

  **Runtime defaults (carried from the tmux work)**

  The built-in `tmux` manager runtime is gone — `tmux` is resolved from `@cotal-ai/tmux`, exactly like
  `cmux`. The default `auto` mode is deterministic `pty`; tmux and cmux are never auto-selected. Choose
  them explicitly with `--runtime tmux`/`cmux`, which fails loud with a clear
  `"import @cotal-ai/<runtime>"` error if the matching extension isn't imported — no silent fallback to
  pty.

### Patch Changes

- Updated dependencies [cce0a6a]
  - @cotal-ai/core@0.8.0
  - @cotal-ai/workspace@0.8.0

## 0.7.0

### Minor Changes

- a6a0a8d: feat: agent orientation, spawn-from-anywhere, live space graph, model-aware spawning

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays 0.2.

  **New**

  - **`cotal_orientation`** — a self/context card MCP tool: an agent's identity, the channels it can
    read and post to, its capabilities, available tools, and who's present. Claude Code, OpenCode, and
    Hermes connectors all point new agents at it on boot for the same first-turn orientation.
  - **Spawn from any directory** — `cotal spawn` resolves a running mesh from a registry, so agents can
    be spawned outside the project directory. The registry self-prunes space-mismatched and stale
    `current` entries; its dir is locked to `0700` so space names aren't world-readable.
  - **Model- and harness-aware spawning** — `cotal start --model` overrides the model, the harness CLI
    is preflighted before spawn, and the harness/model knobs are shared across both spawn doors (CLI
    `cotal spawn` and MCP `cotal_spawn`).
  - **Live space graph** — a force-directed graph view of a space in the web UI, backed by
    broker-sourced authoritative channel membership (offline agents drop from the graph immediately).

  **Fixes & hardening**

  - **Manager persona spawn is fail-loud and ACL-correct.** A spawn (`start` op / `cotal_spawn` /
    roster boot) now treats its argument as a persona ref (a filename in `.cotal/agents`), takes the
    mesh identity from the file's `name:` (auto-numbered on collision), fails loud on a missing persona,
    and always provisions read/post ACLs from the loaded persona. Previously a miss silently minted
    default creds (read `general` only, default-deny publish, no capabilities), so a persona spawned by
    display name, a typo, or a renamed file became a live agent with silently-wrong ACLs.
  - **Mesh-connect resolution unified** — `web`/`console`/`join` (and the transient commands) route
    through a shared `resolveMeshTarget` + preflight: the recorded server/mode is honored (open ≠ auth),
    the `--server`+`--space` raw escape works again for open remote meshes, the `channels` subcommand is
    validated, and a silent wrong-mesh fallback is refused rather than connecting to the wrong broker.
  - **`cotal web` no longer holds the account signing seed.** The dashboard used to keep the space
    `SpaceAuth` (which can mint _any_ identity/role) in scope for the whole session, re-minting on every
    channel delete — a compromise of the loopback process could mint anything for the account. It now
    pre-mints one scoped `manager` cred at startup for the lone write path (channel delete) and lets the
    seed fall out of scope, shrinking the blast radius from "mint anything" to "purge channels as one
    manager". Open / `--creds` modes are unaffected (no seed; they use the connection creds).

### Patch Changes

- Updated dependencies [a6a0a8d]
  - @cotal-ai/core@0.7.0

## 0.6.0

### Minor Changes

- ba5e622: feat(delivery): server-side delivery daemon for the Plane-3 durable backstop, + auth-by-default

  Extracts the durable backstop (the offline catch-up tier) out of the manager into a standalone,
  least-privilege, server-side **delivery daemon** (`@cotal-ai/delivery`, the `deliver` command). The
  manager is now lifecycle-only (spawn/despawn/stop/attach/ps); the daemon owns all of Plane-3 — the
  fan-out writer + trusted reader, the durable-membership registry, the runtime durable join/leave/list
  ops (on a new `ctl.delivery` control service), activation catch-up, and a single-flight lease — and
  re-authorizes durable delivery against a durable read-ACL registry. Live channel reads are unchanged
  (native NATS, broker-enforced). No wire break (`protocolVersion` stays 0.2).

  - The daemon is part of the server: `cotal up` starts it by default and it is coupled to the broker
    (it exits if the broker is gone; `cotal down` / `cotal up` shutdown stop it).
  - **The mesh is now JWT-authed by default** — `cotal setup`/`go`/`up` bring up an authed mesh with the
    durable backstop; pass `--open` for the previous frictionless open, live-only mesh.
  - `cotal_channels` reports honest durable-delivery health (membership + lease aware).

  Hardened over multiple review rounds (sender-bound `ctl.delivery` replies, reconnect-safe responder +
  KV handles, ACL-independent leave so revocation closes the §7 boundary, signer-free daemon runtime,
  responder-after-bind readiness, pid-bound cutover marker), each with a guard smoke.

### Patch Changes

- Updated dependencies [ba5e622]
  - @cotal-ai/core@0.6.0

## 0.5.0

### Minor Changes

- 58f2d41: Self-serve channel join + durable backstop (SPEC v0.3 delivery rebuild)

  Agents whose read ACL allows a channel now join/leave its **live** feed themselves over a native NATS core subscription — manager-free, broker-enforced by `sub.allow` (join = subscribe, leave = unsubscribe). A manager-hosted **Plane-3 durable backstop** (a privileged fan-out writer → a trusted reader that re-authorizes every entry against the current read ACL and membership interval → a per-member DELIVER durable the agent acks natively, SPEC §8) ensures a post still reaches a busy or offline agent on its next turn. Channel membership moves to a privileged cursored KV registry (`cotal_members_<space>`), and channels carry explicit `live`/`durable` delivery classes (default `durable`; a space with no manager is live-only).

  The legacy per-instance `chat_<id>` live-tail durable and the mediated filter-move are removed — one clean model with no coexistence code. This is a wire-protocol change (SPEC bumped to v0.3): new and old clients do not interoperate on channel delivery.

### Patch Changes

- Updated dependencies [58f2d41]
  - @cotal-ai/core@0.5.0

## 0.4.0

### Minor Changes

- 878f406: Control-plane security hardening, agent env isolation, and spawn ergonomics

  - **Three-tier control authz.** Control ops are split into self-service / privileged / admin
    tiers, default-deny, with op↔tier routing that fails closed. `spawn` is now a declared
    capability (`AgentDef.capabilities` → mint → credential grant); destructive / cross-agent ops
    (including `purge`) require the admin tier and are denied to ordinary spawn-capable agents.
  - **Loopback by default.** The control plane binds `127.0.0.1` by default; `--open` is an
    explicit, auth-independent choice and no longer binds `0.0.0.0`.
  - **Spawned-agent environment isolation.** Runtimes pass only the declared env allow-list, never
    `process.env`, with per-connector model-key forwarding — no secret bleed between agents
    (verified by the new `env-isolate` smoke).
  - **Fork-bomb / churn bounding.** A synchronous `MAX_AGENTS` reserved-set ceiling, a
    minimum-lifetime cooling floor, and recursive child reaping bound runaway spawning.
  - **`attach` scoping.** Terminal read/write is gated to an operator's own children, or to the
    admin tier. The `control-auth` smoke asserts the credential boundary is enforced by
    nats-server.
  - Agent transcript mirroring is now opt-in (default off); `spawn` names auto-number on collision.

### Patch Changes

- Updated dependencies [878f406]
  - @cotal-ai/core@0.4.0

## 0.3.2

### Patch Changes

- 34c2cb7: fix(manager): clear all Claude startup gates in the pty runtime

  Claude ≥2.1.178 shows two back-to-back Enter-to-confirm gates on a fresh workspace (folder trust, then the dev-channels warning); the one-shot auto-confirm cleared only the first and hung managed agents at `starting…`. The pty runtime now presses Enter on a short timer during startup (matching the cmux runtime) instead of matching prompt text, so it clears the variable number of gates and the agent joins the mesh.

  - @cotal-ai/core@0.3.2

## 0.3.1

### Patch Changes

- @cotal-ai/core@0.3.1

## 0.3.0

### Minor Changes

- df8e64c: Add `cotal-ai` — a guided, two-tier setup. The composition root (`bin/`) ships as the
  publishable `cotal-ai` package, so `npm i -g cotal-ai` / `npx cotal-ai <cmd>` works (bare
  `cotal` runs `setup`). The **first run** is a narrated, branded flow (`@clack/prompts` UI,
  wordmark splash, a live pane that streams the mesh booting) that checks prerequisites, locates
  the NATS server (bundled platform binary via `@eplightning/nats-server-*`, or one already on
  PATH), then a **connector picker** (Claude / OpenCode — only Claude installs a plugin; OpenCode
  auto-wires at spawn), and writes two default Cotal experts you can chat with — **david — the
  engineer** (how it works) and **sven — the guide** (what to build) — plus **me**, the session
  you drive. The finale is cmux-aware: inside cmux it opens a manager tab that pre-spawns david/sven
  into their own tabs alongside a console + driving session, otherwise a background manager
  pre-spawns them and the terminal is handed to your session. **Later runs** are a compact
  ensure+status card; `cotal setup --full` forces the full flow, and `cotal setup --yes` runs it
  non-interactively (agents/CI) — installs the plugin, writes the experts, starts the web, and exits
  non-zero with the log path on failure. Each failed interactive step offers a Claude handoff
  (skippable with `COTAL_SKIP_ASSIST=1`) that carries the failure context and resumes setup on
  `/exit`.

  Supporting changes across the stack:

  - **core** — `Connector.pluginRoot` (find a connector's installable plugin assets without
    importing the extension), `LaunchOpts.prompt` (an auto-submitted first message), a `TerminalLayout`
    extension contract (a host-side, not-wire contract: open/close editor tabs from a backend-agnostic
    `Tab` — panes as argv + an optional split — resolved by name from the registry), and `findCotalRoot`
    (walk up to `.cotal/`, so `cotal` runs from any subdirectory).
  - **connector-core** — `cotal_purge`, an agent-driven request that has the manager clear the
    space's retained chat backlog (the privileged `STREAM.PURGE` regular agents are denied).
  - **manager** — pre-spawn teammates at startup (`cotal cmux --spawn a,b`, staggered on presence),
    the `purge` control op (native JetStream purge), and a WS attach endpoint.
  - **cmux** — a self-registering `TerminalLayout` provider (plus `listWorkspaces`/`workspaceRefs` on
    the driver) that translates the agnostic `Tab` into cmux's native layout, so `cotal setup`
    opens/closes cmux tabs through the registry without depending on the package or building any
    cmux-shaped layout itself.
  - **connector-claude-code** — MCP isolation for spawned sessions (`--strict-mcp-config` +
    `--mcp-config`, channel ref `server:cotal`), `prompt` passthrough, and the plugin manifest files
    shipped in the published package.

  Adds `cotal up --detach` + `cotal down` for a background mesh. `cotal up` now pre-creates the
  space's JetStream streams + KV buckets for **both** modes (open connects without creds), so
  anything that touches a stream before an endpoint has joined — `cotal spawn`'s DM-inbox
  provisioning, `cotal_purge`, `history clear` — works on a fresh open mesh instead of failing with
  StreamNotFound. When run via `npx` without a global
  `cotal`, setup offers to `npm i -g cotal-ai` (default yes; non-interactive takes the default),
  best-effort — and the status-card hints render the right prefix (`cotal` / `npx cotal-ai` /
  `pnpm cotal`) for how you ran it.

### Patch Changes

- Updated dependencies [df8e64c]
  - @cotal-ai/core@0.3.0

## 0.2.0

### Minor Changes

- 739649a: Spaces model, operator console, cmux onboarding, personas, and faces (PRs #15–#20).

  - **cli** — a lazygit-style Ink `console` over a shared `MeshView`, plus `setup`/`supervise`/`cmux`/`demo` onboarding.
  - **manager** — registry-resolved runtimes (the manager no longer depends on cmux), graceful stop, and `definePersona`.
  - **cmux** — a self-registering `cmux` `RuntimeProvider` with real teardown.
  - **connector-core** — `cotal_persona` and `cotal_despawn` tools.
  - **connector-opencode** — an optional animated face viewer (avatar id read from the agent file's `meta.face`).
  - **core** — space discovery (`listSpaces`/`deleteSpace`), a pluggable `Runtime` extension contract, `DEFAULT_SPACE`, `saveAgentFile`, and a generic `meta` passthrough bag (kept a patch to avoid force-majoring the connectors that peer-depend on core).

### Patch Changes

- Updated dependencies [b3a790e]
- Updated dependencies [739649a]
  - @cotal-ai/core@0.1.3

## 0.1.2

### Patch Changes

- 5f9e171: Publish all packages: add repository field for OIDC provenance, plus in-flight changes (cmux runtime exec-via-env fix, manager runtime selector, .gitignore product/, etc.).
- Updated dependencies [5f9e171]
  - @cotal-ai/core@0.1.2
  - @cotal-ai/cmux@0.1.2

## 0.1.1

### Patch Changes

- 18c271f: Publish all packages: configure GitHub Actions changesets workflow with npm OIDC trusted publishing.
- Updated dependencies [18c271f]
  - @cotal-ai/core@0.1.1
  - @cotal-ai/cmux@0.1.1
