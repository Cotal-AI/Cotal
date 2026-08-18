# @cotal-ai/core

## 0.23.0

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

- 219d33c: `cotal spawn --agent pi --prompt <text>` now delivers the prompt as Pi's initial message (its first turn) instead of silently dropping it; an empty prompt, or one starting with `-` or `@`, refuses the launch. The connector contract no longer describes an initial prompt as something a connector may ignore: a connector delivers it or throws at launch. The other connectors follow the same rule: Claude Code and Codex refuse a prompt that is empty after trimming instead of dropping it, and Hermes refuses an initial prompt outright until its first turn is wired.

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

## 0.20.0

## 0.19.0

### Minor Changes

- 10d9cd6: Adopt the AG-UI event vocabulary, and give a frame a wire identity a reader can recognise.

  Cotal's agent-event stream carried glyph-prefixed text, so a consumer could display it and do nothing
  else with it. The vocabulary replaces the payload: typed events with real identities, an envelope that
  carries its own ordering, and a validator a surface can execute.

  Core gains the frame's identity: the `ag-ui.frame` part kind, the event `type` discriminators, and
  `isAguiFramePart`. It lives in core rather than in a connector because every connector emits it and
  none may redefine it, which is what makes it a protocol shape rather than an adapter's choice. What
  stays out of core is producer-side: the envelope version and every event constructor.

  `@cotal-ai/connector-core` gains the vocabulary itself: the constructors, the frame envelope,
  `parseAguiFrame`, the `AguiBrackets` stream machine, and the `cotal.*` CUSTOM table, which is empty
  in v1. `parseAguiFrame` throws with the offending field named and `isAguiFramePart` never throws,
  because routing and validity are different questions: collapsing them would make a protocol skew look
  exactly like someone else's message, and a surface would show an empty pane for a stream it was
  actively failing to parse. A protocol mismatch and an unrecognised event type are both refused rather
  than partially rendered, since a skipped event is a hole in a transcript that still looks complete.

  Bracketing is a property of a writer's stream and not of a single frame, so `AguiBrackets` is fed
  frame after frame. A frame may legally open a run and not close it.

  Nothing emits yet. The channel derivation, the payload-size split and the publishing emitter are not
  in this change, and no connector constructs a frame outside a test.

  `@ag-ui/core` is an exact-pinned, types-only devDependency: it declares zod as a runtime dependency
  and connector-core is bundled into every seeded connector, so importing it at runtime would ship a
  second zod major to every customer in order to validate events Cotal constructs itself. The
  conformance suite imports the real schemas and parses every constructor's output under the schema
  that owns it, which is what keeps the hand-written literals honest.

- a1bc784: Display an agent event frame, and separate event channels from chat.

  An `ag-ui.frame` part carries no text part by design, so every surface that renders a message as
  flat text drew one as `[unrenderable part kind "ag-ui.frame"]`. A renderer now folds a frame's
  events into readable lines: streamed text and reasoning deltas accumulate into one line rather than
  one line each, a tool call reports its name, its arguments and its result, and a stream that ended
  without its terminator is flushed and marked truncated instead of being dropped. An event type this
  build does not know is named rather than skipped, because a skipped event is a hole in a transcript
  that still looks complete. It registers through the part-renderer seam, so the standard resolves it
  by the part's own kind and never learns what the vocabulary means.

  The renderer is loaded by the composition root rather than by a connector. Connectors are removable
  extensions materialized on demand, and no surface that renders imports one, so a provider that
  registered only inside a connector would be absent from every process that draws.

  The event channel's name and its classifier move into the standard, beside the frame's identity.
  Both are things a reader needs in order to recognise an agent's stream without knowing which adapter
  produced it, and the two surfaces that most need to classify cannot reach an extension package at
  all. The constructor is re-exported from its former home, so no caller changes.

  The classifier is now a derivation rather than a prefix test, and the two disagree on names a real
  mesh produces. Nothing reserves the `events.` prefix, so a channel a human created and talks on
  answered yes to "does this start with `events.`" and was swept out of the chat pane it was sent to.
  A name that does not resolve to a principal is no longer treated as machine traffic, which returns
  those channels to the view, and leaves a malformed publisher visible rather than hidden. The
  collision is narrowed rather than closed: a chat channel whose remainder is itself principal shaped
  is still indistinguishable from an agent's stream, and closing that means reserving the prefix on
  the wire.

  The console keeps event channels out of the channel strip and out of the history prefill. The order
  matters more than the result: the channel list carries one entry per retained subject, so filtering
  after the fetch would read history for every event channel and discard it, which is unbounded work
  to display nothing. Live rows are marked rather than dropped, because hiding them would delete the
  only traffic this change taught the console to draw.

  The dashboard gains the same rendering through a per-kind lookup, so its dispatcher stays ignorant
  of every kind anyone teaches it. A renderer that throws, returns a non-string, or shares a name with
  an inherited object method is reported by name instead of blanking the body. The browser cannot
  import the shared renderer, so the two implementations are held together by an executable
  equivalence check rather than by intent.

  The example harness records a message through the shared renderer instead of keeping only its text
  parts, so a message whose content is not text is no longer written to the transcript as an empty
  string and scored as an agent that said nothing.

  No connector emits a frame yet, and no transcript mirror is removed. Display lands first on purpose:
  a cutover shipped before a renderer would replace a readable mirror with a part every surface shows
  as a marker.

- a7267b3: Refuse a class-queue split before the command runs, instead of reporting it afterwards.

  An endpoint call resolves one incarnation and then invokes through a queue that may pick another.
  Until now the caller was the only party that noticed: the mismatch was detected on the reply, by
  which time the responder had already handled the request. That is why the error had to say it
  proved nothing about whether the command ran: a check that runs after the effect is a report, not
  a guard. In a multi-manager space it is how one spawn becomes several: the effect lands on A, the
  caller bound to B is told the call failed, and the retry duplicates it.

  A request now carries the incarnation the caller resolved against (`bind`, a new optional
  `EndpointRequest` field), and a responder that is not that incarnation refuses at the pre-effect
  seam, before args validation, before target resolution, and before the governed gate that can
  consume a one-use payment proof. The refusal carries `ai.cotal.ep.bind-refused` and states that
  the command did not run, so re-resolving and re-issuing is safe. `failed-precondition` when a
  different instance received it, `expired` when the same instance is at another epoch: the epoch is
  carried even on the instance rail, where the subject grammar has no token for it and a successor
  incarnation would otherwise serve its predecessor's caller.

  The block confers nothing. It can only make a responder the subject already reached refuse, so it
  narrows and never widens, and attribution still comes from the reply subject: a refusal
  attributed to the very incarnation the caller bound is incoherent and is rejected rather than
  honored, so the marker cannot be used to claim an effect away. It is refused rather than ignored
  where it has no reading: on `describe`, which is what produces a bind, and on the scatter rail,
  which addresses every incarnation by construction.

  A long-lived client recovers from the refusal instead of stranding on it. `invokeService` caches
  its resolve, and its existing split recovery keyed on a thrown marker, which a refusal, being an
  ordinary reply, never raises. It now keys on the reply too, drops the stale bind, and re-issues
  the call **once for any command**, not only for one on the repeat-safe allowlist. That allowlist
  exists because a split used to be detected after the responder had handled the request, so core
  could not tell a duplicate-able effect from a repaired one and had to fail closed; a bind refusal
  removes the uncertainty rather than working around it, so the re-issue is a first attempt.

  The allowlist still governs everything else, and that is the half that keeps this safe. A
  responder that predates the fence ignores the field and executes, so its reply proves nothing
  about whether the command ran, and re-issuing on it would duplicate the effect. The re-issue is
  therefore withheld from every reply that does not carry the refusal, and the refusal is checked
  rather than believed: the bind it was computed against must be the one this request carried, and
  the incarnation it claims to be must be the one the reply subject attributes it to. Both halves
  are derivable by the caller, and neither is something an unfenced responder can produce by
  accident. A refusal that fails either is `internal`, not a licence to try again.

  A re-issue that cannot be resolved surfaces the refusal, not the resolve. Re-resolving goes back
  to the registry, and an endpoint that has since retired answers nothing, so a stale handle used
  to be met with a describe deadline ten seconds later, with the one fact that said the command had
  not run discarded on the way. The refusal now surfaces, carrying its marker, with the resolve
  failure named as the reason the repair could not be attempted.

  That recovery is counted, and the counter is the point. Handling a split makes it invisible, and
  the routing event is the only evidence the split exists at all; silence it and the split rate
  becomes unmeasurable exactly as it becomes survivable. `CotalEndpoint.splitRecoveryCount` is
  always on and never behind a flag, and a `split-recovered` event carries the same fact for anyone
  listening; the event can be missed, the count cannot. On a live two-manager mesh, 5 of 6 unpinned
  class-anycast reads split, so this is not a rare-event counter.

  The caller-side check remains, and remains necessary: a responder that predates the fence ignores
  the field and executes, which leaves the older after-the-fact report, and the allowlist, as the
  only protection in a skewed pair. That pair is now driven directly rather than argued about, by a
  hand-rolled responder that answers the class rail without a fence; `serveEndpoint` cannot produce
  the case, because its fence refuses a mismatched bind before the handler, so a request it executes
  is one whose bind matched. `--on` still addresses a specific manager, but it is no longer what
  stands between a split and a duplicated effect.

  The suites count executions at the responder rather than publishes at the caller, and the change
  was forced. "One publish" meant "one execution" only while a split was caught after the responder
  had handled the request; under the fence the second publish carries the first execution, so the
  old instrument reports a correctly repaired call and a duplicated one identically. Where a claim
  narrowed, the cell says which condition moved it rather than being replaced.

  SPEC §13.2 and §13.3 carry the normative rules; `docs/control-surface.md` is updated.

- 5e95736: `replyRefusedBeforeEffect` no longer reads a self-contradictory reply as a refusal. The
  `bind-refused` marker asserts that the command did not run, but the detail carries no outcome of its
  own, so a reply could pair the marker with `outcome: "executed"`. The only consumer of this predicate
  re-issues a command without the repeat-safe gate, so that contradiction was being resolved by
  re-sending a command the same reply said had already run. A present outcome that disagrees with the
  marker now wins. An absent outcome is still accepted, because the spec permits omitting it and
  requiring it would stop core repairing splits for responders that do.
- 19931dd: Add the generic part-renderer seam, the principal-channel grant witness, and expecting publish.

  `PartRenderer` lets a surface draw a part kind core does not know, resolved by the part's own `kind`
  so core never learns what any of them mean. A kind with no renderer and a renderer that throws get
  different markers: a reader who meets one must not conclude the other, and neither may blank the
  message or take the surface down.

  `principalChannelWitness` / `assertPrincipalChannelGrants` catch a grant that matches no
  principal-keyed channel. Keying a channel on a principal costs one token more than the flat form it
  replaces, so an operator holding an old single-token wildcard gets a grant matching nothing, which
  at the broker is indistinguishable from a channel with no traffic. The launch reports success and
  the stream is silently mute. The mismatch is now named at grant time, and a witness subject is
  returned rather than a boolean so a refusal can show the operator a subject their grant would have
  covered.

  `multicastExpecting` / `encodedSize` publish under a subject expectation, with the envelope built in
  one place so a frame and any measurement of that frame cannot describe different messages.

  A name carrying an unpaired UTF-16 surrogate is refused: it cannot survive UTF-8 encoding, so
  distinct names would otherwise collapse into one identity.

  `assertExpectationSemantics` now states its scope correctly. The `num_replicas: 1` requirement is a
  property of the one chat stream it reads, not of the broker, and the old message read as a global
  rule. A clustered deployment runs fine so long as that stream is R1, which a cluster can host.

- 6074c26: Export the journal action rail from the package barrel, so a consumer can actually reach it.

  `endpoint-goaleff`, `endpoint-epname` and `endpoint-effects` shipped as package-private modules.
  They carry the durable action machinery the journal rail is built on: the at-most-one-launch
  election and its edge assertion, the endpoint name claim and its edge assertion, and the effect
  decision. Every sibling `endpoint-*` module is re-exported from `index.ts`; these three were not,
  so `@cotal-ai/core` did not expose the surface they exist to provide and nothing outside the
  package could import them. That was an omission rather than a decision: no consumer had asked for
  them yet, and nothing failed while none did.

  The freeze guard could not have caught it, and its green was not evidence either way. That scan
  walks exported arrays and plain objects to prove each is deep-frozen; all five of these exports are
  functions, so the scan is structurally blind to them and reports the same 18 arrays and 12
  plain-objects whether or not the modules are exported at all. A guard that cannot distinguish the
  change from its absence is silent about it, not supportive of it, and reading its pass as coverage
  is how an omission like this survives.

  So reachability is now asserted directly rather than inferred from that pass: each module's runtime
  exports must be identical, by reference, to the barrel's same-named export. This reuses the identity
  technique the suite already applies to its allow-listed re-export subpath. Dropping any one of the
  three export lines reddens that module's named cell and only that cell.

- cb9e1ad: Journal-class admission: enforce the fourth I-JSON condition, key the admission ceiling on the
  class rather than the action marker, hold decision facts to the idempotency horizon, and register
  the three coordination record kinds with their commit-path grants.

  Out-of-range numbers are now quarantined. `JSON.parse("12345678901234567890")` yields
  `12345678901234567000` and reports nothing, so a submission was admitted and its durable decision
  bound a value the caller never sent. The check reads the raw bytes, because the parse destroys the
  evidence, and its predicate is round-trip stability rather than magnitude: `0.1` is inexact in
  binary and perfectly legal, while a literal that cannot survive text to double and back is not.

  The admission ceiling is required on every journal-class command instead of only on those carrying
  the action composite. A journal-class command without the marker was accepted with no ceiling and
  refused if it declared one, though the journal rail's bind rows are derived from the class and
  never from the marker.

  `createEndpointStreams` now refuses a fact retention below the declared idempotency horizon. The
  horizon is realized by retention rather than by a clock, so a shorter age does not shorten a
  guarantee; it removes the mechanism, and a redelivered submission whose decision fact has been
  evicted is accepted as new work. The horizon is a declared option defaulting to the documented
  constant.

  `goaleff`, `epname` and `epmig` are registered record kinds, and the commit path's grant enumerates
  each at its own width. Registering a kind does not grant it, and a kind absent from that
  enumeration is denied however it is registered.

- be624af: State the effect outcome structurally when a bind refusal's re-issue cannot be resolved. The
  error's message asserted the command had not run while its `outcome` field was absent, and an
  omitted outcome must be read as `unknown` (SPEC 13.3), so the prose and the field a caller keys
  on disagreed on the one path whose purpose is to be conclusive.

### Patch Changes

- 48c6631: A bind refusal that omits `outcome`, or states `unknown`, no longer licenses an automatic
  re-issue: only an explicit `not-executed` does. Third-party responders that emit the
  bind-refused marker without the outcome field will see their splits surfaced to the caller
  rather than repaired, which is what the spec requires, since a refusal raised before dispatch is
  required to carry `not-executed` in the first place.
- ce1c248: A bind refusal is now checked for self-consistency whenever it carries the bind-refused marker,
  rather than only when it also states `not-executed`. The checks establish that the reply is an
  answer to this request from this responder, and that question does not depend on the outcome
  field, so a refusal that omitted the outcome previously skipped them and was surfaced
  unvalidated. Whether a caller may act on such a refusal is unchanged and still requires an
  explicit `not-executed`.
- 87c4130: Say what a refused publish, a goal deadline, and a class-queue split actually proved.

  A refused publish now reports itself. `nc.publish` is fire-and-forget: a caller whose credential
  does not authorize the subject gets an asynchronous answer on the _connection_, so the publish
  returns normally and the only observable is that no reply arrives. That is indistinguishable from
  an absent responder, though the two need opposite responses: mint the grant, or go find the
  responder. An instance-addressed describe made with a class-rail credential is exactly that case,
  and it read as an unresponsive manager: measured live, `ps --on <instance>` returned `no describe
reply from manager within 10000ms` against a 115ms RTT while an untargeted describe answered from
  either instance in well under a second. The describe now watches its connection for a permission
  violation on its own subject and raises `permission-denied` naming that subject, the instance rail,
  and the fact that the responder may be perfectly healthy. The watch closes its status iterator on
  every exit, so it does not leave a listener parked on the connection per resolve.

  A goal that produced no terminal in time no longer implies the goal failed. It was accepted; only
  its terminal did not arrive within the wait. Observed live: seats that reported this had already
  come up and were messaging peers, and retrying submitted a second goal that duplicated the effect.
  The message now says the deadline is on the wait rather than the work, and says not to retry on it
  alone.

  An unpinned class-queue split no longer implies the effect did not land. Describe and invoke are
  separate trips through the same anycast queue, so in a multi-instance space the instance that won
  the queue received the request and may have executed it, possibly after the error was raised. The
  core message now says so and points at `ps`/`inspect`/roster before any retry; it stops at "a call
  that addresses one instance does not split". The CLI adds `--on <instance>` as the remedy, and only
  on the commands that have the flag (`ps`, `stop`, `attach`, `spawn --detach`), which declare it to
  the shared renderer; `models`, `up` and `down` ride the same rails and split the same way, and are
  no longer told to type a flag they do not have. Absence of a pin is not evidence of the flag.

  And a split is no longer silently retried into a duplicate effect. The client recovered from
  `failed-precondition` by dropping its cached resolve and invoking again, which is a repair when the
  bound incarnation is gone but a second attempt when the error came from a different live instance
  answering the class queue: request received and answered (executed or refused; the reply does not
  say which), error raised afterwards. Re-invoking there re-issued the command automatically, while
  the error text told the operator not to retry; it is the mechanism behind one spawn producing
  several seats. The retry now happens only for commands
  whose second execution is observably indistinguishable from one: the reads and `describe`. Every
  other command surfaces the split to its caller, carrying a marker that says a responder did answer
  the request, so the caller can check before deciding. Surfacing also drops the stale bind: the
  cached resolve named an incarnation a different live instance has just answered for, and keeping it
  would send every later deliberate call on that endpoint into the same refusal, so the caller could
  verify and still never reach the live instance. Dropping it re-issues nothing; the next call is the
  caller's own.

  The same rule now covers the adjacent case, a manager restarted in the same workspace root. That
  restart keeps the logical instance id and advances its epoch, so a client that resolved before it
  gets its next answer from the same id at a later epoch: `expired`, raised after the attributed reply
  just like the split. It used to be rethrown untouched with the bind kept, so a long-lived client
  (a connector's mesh agent, the console) reached the successor on every later call, may have applied
  the effect each time, and never recovered. The stale-epoch refusal now carries the same
  responder-answered marker, the guard keys on the marker rather than the error code, and its message
  says which side is stale: a responder ahead of what the caller holds is a successor (re-resolve to
  adopt it), one behind is a superseded incarnation still answering. The old text called the caller's
  own bound epoch the responder's "current" epoch, which named the wrong side.

  That classification is an allowlist and fails closed at both levels. It is keyed by endpoint, not by
  bare command name, because the client is endpoint-agnostic and a flat list would lend the manager's
  judgement to any endpoint that happened to reuse a name; an endpoint nobody has classified has no
  repeat-safe commands, and an unlisted command is surfaced rather than repeated. `describe` is the one
  exception, and structurally so: it is served by the machinery on every endpoint and can never be
  redefined into something that mutates.

  `models` is deliberately not on that list even though it is a read command. With `{refresh: true}` it
  reaches the connector's model listing and, for OpenCode, re-fetches provider catalogs and rewrites a
  cache: the same name, in the same grant class, answering differently because of an argument the
  classification cannot see. A long-lived client invoking `models` through `invokeService` therefore
  surfaces a split rather than absorbing it in a multi-instance space; encoding per-command argument
  rules here would reintroduce exactly the fail-open shape this replaced.

  Where this table bites, precisely: it is read only by `CotalEndpoint.invokeService`, the long-lived
  client path. Its shipped callers are the connector's `cotal_*` manager tools (spawn, inspect, stop,
  despawn, purge, define-persona), `cotal spawn -f` (launch) and `cotal down -f` (despawn), whose
  splits now surface instead of being re-issued, plus the repeat-safe `ps` reads of `spawn -f`,
  `down -f` and the console, which keep absorbing them. The one-shot CLI commands (`cotal ps`,
  `cotal models`, `stop`, `attach`, `spawn --detach`) resolve fresh and invoke once on a short-lived
  connection; they had no cached bind and no retry, and are unchanged. That is the clearest statement of what the list is: a client-side
  stand-in for `effect` (SPEC 13.7), which the wire now carries and this change does not yet consult.
  The spec grew both halves after this work began: `effect` declares whether repeating a command is
  safe, and rides `protocol.v: 2`, while this tree still registers and resolves at `v: 1`, under which
  every command reads as a write. Reconciling the two is a separate change and is named here rather
  than described as absent from the wire.

  The CLI no longer prefixes every failed manager call with "no manager reachable on the ep rails".
  That verdict is stated only where the call went unanswered, as core marks it: no responder, or the
  reply deadline elapsed with nothing attributed to the request. The catalog code alone was not
  evidence of that. A manager that answers its describe with `ok:false` has the refusal rethrown under
  its own code, `unavailable` included, and a store read after an answered describe raises the same
  code; both printed as an unreachable manager while a manager was answering (reproduced live during
  review). Core now sets a detail kind on the producers that observed silence and the CLI keys on it,
  never on the code. A registry read on the caller's own side (the scatter's freeze or its reconcile)
  is a third outcome with its own line, since the managers were not the failure and may all be up. A
  refusal that states its own cause (a describe refused by the broker, a split, a stale epoch) is
  printed as it is, because the prefix contradicted it, and an unanswered `--on <instance>` names the
  instance that did not answer instead of pronouncing on the mesh (measured: three managers answering,
  one typo in `--on`, "no manager reachable"). `up`'s resume readiness poll keys on that same
  unanswered fact rather than on the message prefix.

  `ps` prints the full instance id in its multi-manager view. That view appears only where the split
  makes `--on <instance>` the one way to address a manager, and `--on` accepts nothing but the whole
  26-32 character lifecycle token, so an abbreviated header named the remedy and withheld the value
  it needed, and `--on <prefix>` was refused as a malformed token. The `stop`/`attach` seat-lookup
  miss, which lists the instances that did not answer for the same purpose, prints them whole too and
  says the id must be passed as printed. `spawn` refuses `--on` outside a detached imperative spawn: a
  foreground spawn has no manager to pin and a manifest deploy launches through the manager class
  queue, so the flag was accepted there and silently ignored. An empty `--on` (`--on ""`, an unset
  shell variable) is refused at the flag on all four commands: `ps` and the detached `spawn` carried it
  to the mint, which refused it as an invalid token, while `stop` and `attach` read it as absent and
  fell through to the seat lookup, so one input had two answers and one of them was a dropped pin.

  The peer-side manager tools stop reading silence off the catalog code too. `MeshAgent`'s manager
  invoke reported "no responder answered - a manager may be down, or this credential holds no <cmd>
  capability and the broker denied the request" for every `deadline-exceeded`, and the bare code for
  everything else. That was wrong in both directions. The broker's no-responders 503 arrives as
  `unavailable` carrying the unanswered marker, so the one case where the capability explanation is
  certain was the one case that did not get it: an agent denied a capability was told only
  "unavailable". And an answered `ok:false` describe is also `unavailable`, deliberately unmarked
  because a manager did answer -- and this surface is read by agents, where a claim of silence invites
  the retry that duplicates a spawn. Same code, opposite conditions, separated only by the marker,
  which is now what the verdict keys on.

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

- 758e1e3: Pin `json-canonicalize` exactly, so a published install cannot resolve a broken tarball.

  `json-canonicalize@2.0.1` was published without the `bundles/` directory its own `package.json`
  `main` points at. A `^2.0.0` range therefore resolves, on any fresh install, to a package that
  cannot be imported: `cotal --version` crashes with `ERR_MODULE_NOT_FOUND` before printing
  anything.

  The repo never saw it. A lockfile pins 2.0.0 and CI stayed green throughout; a published package
  carries no lockfile, so npm re-resolves every range at install time and users got a version CI had
  never exercised. That gap between what CI resolves and what an install resolves is the actual
  defect this fixes.

  Both ranges are now exact, and `smoke:dep-pins` keeps them that way: it fails if either floats
  back to a range, and fails if its quarantine list stops matching any declared dependency, so a
  list that has quietly stopped applying cannot read as a list that holds.

  Stated as a limit rather than left implied: the new cell proves the range is exact, not that the
  pinned version is installable. Only installing the packed tarball against the live registry proves
  that, which is `smoke:seed-tarball:live` - and that suite sits outside `smoke:ci`, so the
  instrument that would have caught this incident exists and does not run. Wiring it into the gate
  is a separate decision about live-network tests in CI, not something this change makes quietly.

- 8572a5d: Report which bind went stale when a class-queue split is recovered, and grade the describe/invoke
  probe's forced arm on the caller-visible contract.

  `split-recovered` carried `servedBy`, the incarnation that answered, without `boundTo`, the one the
  handle thought it was addressing. A listener could therefore see that a split had been recovered but
  not which bind went stale, which is the difference between one handle to drop and a class that is
  churning. Both halves of the fact are now on the event.

  The probe's forced arm previously required the repair to land, which asserts a coin comes up heads:
  core repairs a bind refusal exactly once and lets a second refusal surface, while in a two-manager
  space roughly half of all class-queue calls split, so the re-issue goes back through the same queue
  and is split again about half the time. That second refusal is a correct and conclusive outcome, and
  grading it as a failure reddened the suite on runs where the property it exists to protect held
  completely. The arm now accepts either face: the repair landed exactly once, or it was refused again
  and stated that nothing ran.

  Accepting an absence of effects requires proving the arm could have produced one, so a positive
  control on the arming runs before any question about the outcome. The forcing writes a bind naming no
  live incarnation; the control reads it back through a fresh cache lookup, proving the entry the
  client sends from was mutated rather than a copy, and requires the first refusal to name that bind.

  Without it the ambient system supplied the signal. The probe's space splits naturally about half the
  time, so a run that forced nothing still saw a refusal, a repair, and a second refusal naming a
  different instance: every symptom of the case under test, produced by the ordinary race. Measured
  with the forcing removed, the arm passed 4 of 6 runs. With the control it is caught 6 of 6. Reading
  the first refusal's bind is what required it on the event, because once the repair re-issues, the
  error the caller ends up holding names the second refusal and not the first.

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

- 4d14037: `cotal_persona`: defining a persona no longer announces on the mesh by default

  Defining a persona used to post "persona X is now available — spawn it to bring it online" on the
  definer's first concrete channel — `#general` for most personas, since nothing ever chose the
  destination: the send passed no channel, so it fell through to whichever concrete channel happened
  to be first in the caller's list. Standing up a review panel therefore put one broadcast per seat
  into every peer's inbox, and the wording read as an instruction to strangers to launch an agent they
  knew nothing about, from a principal they had no relationship with.

  `cotal_persona` and `MeshAgent.definePersona` now take an optional `announce` channel:

  - **Omitted (the default): silent.** Nothing is published.
  - **Supplied: that channel only**, never one inferred from ordering, with post rights enforced by
    the broker as for any other message and no fallback. The channel is validated before the write, so
    an empty string, a wildcard, or a name the subject layer would rewrite is refused loudly rather
    than publishing somewhere you did not name.
  - The message is now a statement of what the sender did rather than an imperative aimed at the
    reader.
  - A persona whose announcement is refused is reported as **saved but not announced**, pointing at
    `allowPublish` — not as a failed definition, which named the wrong fix and invited a retry that
    posted the duplicate.

  No durable or deliberately-consultable read path is removed: `cotal personas list` / `show` read the
  catalog directly within a workspace, and `cotal_spawn` still fails loud on a name that does not
  exist. What is lost is unsolicited awareness of a bare name — real discovery, but incidental,
  incomplete (no prompt, model, or role) and invisible to anyone who joined later.

  `@cotal-ai/core` gains `isPublishPermissionDenied`, a public helper beside `isPermissionDenied` that
  is true only for a typed permission violation whose `operation` is `"publish"`. `isPermissionDenied`
  is deliberately operation-agnostic — it separates a denial from a missing service, where the
  operation is irrelevant — so it cannot answer "did this message get stored?". A JetStream publish is
  request/PubAck, and a denial on the reply-inbox _subscription_ rejects `js.publish()` while the
  stream may already hold the message. Callers that report delivery must ask the narrower question.

### Patch Changes

- f6b8b27: fix(core): reconcile presence/lease bucket TTLs at `cotal up`

  A presence or lease KV bucket created by a cotal that predated the bucket TTLs kept no `max_age` and never expired dead presence records or stale leases, so a crashed agent could linger in the roster / raw KV as live indefinitely (#286). `kvm.create(bucket, { ttl })` never updates an existing bucket, so repeat `cotal up` runs could not fix it either. `setupSpaceStreams` now reconciles the three TTL'd buckets' `max_age` via `STREAM.UPDATE` on every `cotal up` (idempotent: a bucket already at the TTL is skipped; the `duplicate_window` is lowered in the same update to satisfy `duplicate_window <= max_age`), and the `provisioner` credential is granted `STREAM.UPDATE` on exactly those three streams — nothing else. The reconcile reads the config back afterwards and throws unless `max_age` came back exactly as intended and `duplicate_window` does not exceed it — it does not verify the window came back as sent, and it does not prove expiry is enforced. That is a drift detector, not proof of enforcement, and the limit is worth stating: on the supported nats-server floor the update is applied in two places — the in-memory stream config, and the file store — and the server ignores the file store's error while answering `STREAM.INFO` from memory. A metadata-write fault (EACCES, ENOSPC) can therefore return OK, read back correctly, and leave the backing store without an expiry timer. This read-back cannot see that, because both fields it reads come from the config that did update — but it is not undetectable: the STREAMED snapshot's first `meta.inf` entry carries the file store's own config, so a store-side detector exists and was reproduced live. It is not wired in here: the snapshot scope this repo already models REJECTS these three buckets, so it would need a new exact scope or a widening of the reconcile credential to whole-body authority over liveness data — an unsettled authority question, not merely a cost one, though the cost is real too (it scales with bucket size, and a snapshot carries the bucket's records); a behavioural suite proves records actually age out on a healthy server, and the detector is recorded in the tracking issue. The remaining window is documented with its upstream mechanism in the tracking issue. `reconcileBucketTtl` is exported so that fail-closed behaviour can be driven directly against a broker that accepts an update without applying it.

  **Behaviour change worth stating plainly: `cotal up` against a mesh that is ALREADY RUNNING now performs a config write on it.** It has to — a bucket can only have drifted on a mesh that has been running since before the TTLs existed, and that is exactly the case that previously returned "already running" without reconciling anything, so the fix repaired only the deployments that never had the problem. The reconcile runs before the success line (a tick printed over an unreconciled mesh is the silent drift this removes), refuses loudly rather than continuing if it cannot complete, and reads first — a mesh already at the intended TTLs takes three reads and no writes, so a repeat `cotal up` stays a no-op. When it does change something it says so. Authed meshes mint an ephemeral `provisioner` credential for it, the same enumerated scope the create path already mints and discarded with the connection; open meshes need no credential and are not exempt, since the TTL'd buckets are not mode-gated — the fix rides `setupSpaceStreams`'s existing credential contract rather than introducing a new rule.

  **A limit of the read-first skip, corrected after review.** Where an unenforced bucket ends up depends on WHEN the metadata write failed, and an earlier draft of this note generalised from one reproduction. `writeStreamMeta` performs two writes — `meta.inf` then `meta.sum` — with no pair-level atomicity. A failure before the first commits leaves persisted state coherent and old, so a restart reveals it and the next reconcile repairs it. A failure BETWEEN the two leaves `meta.inf` new and `meta.sum` old; on restart the server logs `checksums do not match` and recovery skips the stream, so `STREAM.INFO` returns not-found and the reconcile cannot repair it. Both branches were reproduced live during review. So the worst case is an unavailable bucket, not merely an unexpired one — rarer than the first branch and more severe.

- d361951: Release the connection `probeConnect` never established.

  `probeConnect` is the one connect site whose normal case is a dial that fails — it exists to be
  pointed at addresses that may not answer. Against an address that BLACKHOLES (SYN unanswered)
  rather than REFUSES (RST) it returned its correct verdict on the deadline and then leaked the
  pending socket: one orphaned socket per probe, reclaimed only when the OS SYN timeout fired
  minutes later, so the process could not exit. A probe against a non-routable literal returned
  `unreachable` at 1006ms against a 1000ms contract and the process still had to be killed at 20s,
  while five probes left five socket fds behind and never gave them back.

  The teardown could not be added where it appeared to be missing. It is upstream:
  `@nats-io/transport-node`'s `NodeTransport.dial()` keeps its socket in a local until the handshake
  resolves, so `this.socket` is still undefined when the client's own connect timeout wins its race
  and the catch calls `transport.close()` — whose teardown is `this.socket?.destroy()`, a destroy of
  nothing. No caller option (`reconnect: false`, `timeout`) reaches the orphan, and a `finally` here
  would close a connection we never got.

  So the address is now reached on a socket we own before it is handed to `connect()`, and that
  socket is destroyed on every exit path. The gate asks only whether TCP completes, never whether
  NATS is speaking there, so a TLS-first listener still passes it and goes on to a real connect, and
  `connect()` receives the remainder of the budget its own timeout always covered. No verdict
  changes: anything past the gate had to complete a handshake for `connect()` to have gotten
  anywhere either, and both paths now share one failure classifier, so a locally provable credential
  death stays `stale-auth` instead of being downgraded to `unreachable` by a dark address.

  Operators see no behaviour change from the `cotal` binary, which force-exits at the end of a
  command and so escaped the leak. What was affected is anything embedding `probeConnect` as a
  library — including this repo's own suites, one of which had to route around the path entirely to
  stop hanging as a gate step.

## 0.17.0

### Minor Changes

- 975cad1: Give each space an artifact object store, with a real size limit.

  The `artifact` message part references bytes that live outside the message; this is where they live.
  Every space now gets a JetStream Object Store alongside its other streams, created by the same setup
  that creates them and removed by the same teardown.

  It carries an explicit 4 GiB cap, which is the point rather than a detail. A fresh object store ships
  unlimited, and a space's account is provisioned with unlimited disk, so "the account limit bounds it"
  would have bounded nothing — artifacts could grow until the disk did, starving the chat and delivery
  streams sharing it. Reaching the cap refuses the write instead of evicting older objects, so a
  reference published yesterday cannot quietly stop resolving.

  A space resource has to be listed in five separate places — created, deleted, granted, enumerated for
  backup, and recreated on restore — and being in four of them is the failure that reads as correct.
  Excluding the store from backups does not mean restore skips it: restore rebuilds every excluded
  resource and then asserts each one exists, so a store left out would fail a restore rather than
  quietly come back missing. The store is excluded under its own class rather than borrowed from an
  existing one, because artifact bytes are neither transient, derived, nor a lease, and calling them
  derived would suggest something could recompute them.

  Two smokes join the gate. One proves the store against a real broker by enumerating what the broker
  actually holds — created, matching the inventory exactly, carrying its cap, and gone after teardown —
  because create and delete are claims about a broker and cannot be checked any other way. The second
  was already in the repository, asserting the stream inventory, and no script had ever run it; it is
  now registered and gated, and it fails correctly on this change.

- c76a49d: Add the `artifact` message part: a reference to bytes too large to send.

  Every Cotal message rides one NATS message under the broker's maximum payload, so moving a file
  between agents has meant pasting bytes into chat until it breaks, or sharing a filesystem path that
  stops working the moment two agents are not on the same machine. SPEC §5 reserved the answer; this
  defines it. A message can now carry `{ kind: "artifact", name, mediaType, digest, size }` — the
  content address of the bytes, and nothing about where they live, so the store behind it can change
  without any message changing shape. This is the contract only: the transport that serves the bytes
  lands separately.

  The digest is the one field that is not taken on trust. `name`, `mediaType`, and `size` are
  whatever the sender wrote, and a receiver that sizes a buffer from `size` or dispatches on
  `mediaType` has believed a stranger; `verifyRawBytes` checks fetched bytes against the digest before
  they reach a caller, which is what catches a store handing back a truncated object — otherwise
  indistinguishable from a small one.

  `artifact` is a bare core kind rather than a namespaced extension, because reverse-DNS kinds are for
  wrapping vocabularies Cotal does not own, and this is Cotal's own reserved primitive. That
  distinction has teeth: a core kind the message validator does not know is not a schema detail. The
  validator gates the durable delivery frame, so an unrecognized core part means the backstop drops
  the whole message, silently, and the loss shows up nowhere near the part that caused it. The
  `artifact` guard is enforced there, and it checks the digest's form rather than only its type — a
  malformed digest is not a reference to anything, and admitting one would turn a bad message into a
  "missing artifact" that blames the store.

  Message rendering moves to a single `partsToText` in core. The same one-line expression had been
  copied into the connector inbox, `cotal join`, and the mesh view, and each copy fell back to
  stringifying a part's `data` field — which an artifact part does not have, so all three would have
  rendered it as the literal word "undefined". One renderer means a new core part kind is legible
  everywhere at once, or nowhere, never in two surfaces out of three.

- fd361fe: Serve the broker over TLS: the transport foundation, with the omission cases made unrepresentable.

  `serverConfig` and the new `openServerConfig` take a REQUIRED `transport` discriminated union
  (`plaintext` | `tls-required { certFile, keyFile }`) instead of an optional TLS field, and
  `standaloneConnectOpts` now requires an explicit `tls` boolean with no default. Both are breaking,
  and both are deliberate: an optional transport is omitted by default, and the omitted case is the
  dangerous one. A client with no TLS requirement still connects to a TLS broker — it upgrades the
  same socket after reading the server's unauthenticated `INFO` — so nothing looks wrong until an
  on-path attacker forges an `INFO` without `tls_required` and collects the credentials that a NATS
  client sends in its `CONNECT` line.

  Also in this change:

  - `cotal up`'s open (no-auth) mode now renders a config instead of launching from bare CLI flags, so
    no path reaches a listener without naming its transport. Previously a cert/key pair given to an
    open-mode `up` would have been accepted while the broker came up in cleartext.
  - `validateTlsMaterial` checks readability, private-key mode, pair match, validity window and
    dial-host SAN before the broker starts, because `nats-server` does not: it reports an expired
    certificate valid, starts, and serves it, and only the client fails.
  - `probeServedCert` / `assertServedCertMatches` complete a real STARTTLS upgrade and read back the
    leaf actually being served, so a rotation is proved rather than assumed. Renewing files on disk
    does not reload `nats-server`.
  - A durable broker launch policy records the transport so a TLS decision survives `cotal down`, and
    refuses rather than degrading when it cannot be honoured.
  - `MeshEntry.tlsRequired` carries TLS-required client intent (never cert paths) through to
    `Connection` and `endpointAuth`, so a CLI-resolved connection inherits the recorded decision.

  `allow_non_tls` is never emitted: it is mixed mode, and a client that declines the upgrade is served
  in cleartext. `handshake_first` and `verify`/`verify_and_map` are likewise never emitted — mTLS is a
  deliberate non-goal, since identity here is JWT/NKey plus the auth callout.

  ## What this guarantees, and what it does not

  **The guarantee.** `cotal up --tls-cert <cert> --tls-key <key>` either serves TLS or refuses to
  start. There is no third outcome. The transport is decided once, above every branch in `up`, so the
  manifest (`-f`), `--detach`, refresh and restore routes cannot reach a listener without naming it;
  each route re-checks the certificate against the host clients will actually dial. A running broker
  cannot change its transport, so passing the flags to an already-running mesh is refused rather than
  answered with a success line. The decision is recorded, so a later bare `cotal up` after a
  `cotal down` keeps serving TLS instead of silently reverting to cleartext.

  **A direct `CotalEndpoint` construction still defaults to plaintext.** `EndpointOptions.tls` remains
  optional and absent still means "no TLS required". If you build an endpoint yourself rather than
  going through `cotal up` or a resolved mesh record, you must pass `tls: true`; nothing will tell you
  otherwise, and the connection will succeed either way against a TLS broker because a NATS client
  upgrades the same socket once it reads the server's `INFO`. Making that field required is a tracked
  follow-up. It is called out here because "Cotal supports TLS" is not something you should be able to
  believe while your own client is connecting without requiring it.

  **Client-side strictness is NOT complete, and the honest scope is wider than a short list.** The
  broker refuses cleartext, so none of these connects in the clear against a healthy TLS broker — a
  NATS client upgrades the same socket once it reads `tls_required`. What they lack is their own
  requirement, which is the fence against a stripped or forged `INFO`, and that is the whole reason
  this feature exists.

  Two distinct cases, and the second is worse:

  _Never had a TLS path / passes `tls: false` explicitly._ `waitForDeliveryLease`
  (`packages/core/src/lease.ts`) builds its own `connect` options rather than going through
  `standaloneConnectOpts`. The user-auth service and the membership feed connect the same way.
  The **enumerated** `standaloneConnectOpts({ … tls: false })` sites at this tip (twelve, not a
  prose list) are:

  | File                                       | Lines              | Role                                                                                                                                                              |
  | ------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `packages/core/src/channels.ts`            | 166, 192, 217, 238 | channel-registry helpers                                                                                                                                          |
  | `packages/core/src/streams.ts`             | 322, 369, 398, 439 | stream/history helpers                                                                                                                                            |
  | `implementations/cli/src/commands/up.ts`   | 1155, 1234         | `provePreparedRestoreListener` / `proveOrdinaryResumeListener` authenticated JetStream proof (restore + ordinary-resume adopt only — not bare `up` / bare `down`) |
  | `implementations/cli/src/commands/down.ts` | 651, 691           | `assertControlPlaneQuiesced` / `readPresenceWithoutConsumer` — **only** on `down --preserve-state`, not bare `cotal down`                                         |

  Bare `cotal down` does **not** hit those two `down.ts` sites: it stops via pidfiles
  (`stopLocalProcess`) and never opens a broker wire. Live-checked twice: `up --detach --open
--tls-cert/--tls-key` then bare `down` (with `NODE_EXTRA_CA_CERTS` stripped on the down step) stops
  manager, delivery, and nats-server and leaves the port `ECONNREFUSED`. There is no silently-skipped
  safety gate on ordinary teardown.

  `down --preserve-state` is the only path that calls `assertControlPlaneQuiesced` (via
  `isReachable(mesh.server)` at `down.ts:585`, then the `tls: false` connects at :651/:691). Bare
  `isReachable(server)` is a plaintext INFO probe (`tcpInfoProbe`): on this branch's STARTTLS TLS it
  still returns **true** (INFO precedes the upgrade), so the quiescence gate is **entered**, not
  skipped, when the client trusts the CA. **Narrow residual (do not fix in this branch):**
  `down --preserve-state` **and** a CA the client does not trust — then a stricter `{tls:true}` probe
  would fail, the INFO probe still says up, and the subsequent authenticated connect without a trusted
  CA fails or the cut proceeds without a completed wire-truth lease proof depending on the failure
  mode. Same family as the private-CA diagnosis gap (S7); incomplete client fence, not an ordinary-path
  break. Flagless sites mostly **work** via auto-upgrade and are **unfenced** (no own requirement
  against a forged INFO), not "broken teardown."

  _Resolves the decision and then drops it (partially closed)._ `cotal web` now passes
  `tls: conn.tls` into its endpoint. `cotal status` carries `target.tlsRequired` on the Selected Mesh
  preflight, the open/auth live snapshot, the user-mode connection probe and user live snapshot, and
  the Recorded Meshes liveness check — a mesh recorded `tlsRequired: true` is not greened by a bare
  TCP/INFO probe against a plaintext substitute. What still drops the decision: the mesh manager
  (`startManagerDetached`'s options type has no `tls` field, so `ensureControlPlane` forwards `--tls`
  to the delivery daemon and then launches the manager without it), plus the never-had-a-path sites
  above.

  Client-side strictness landed for: `cotal up` (every route to a listener), the recorded mesh record
  (`MeshEntry.tlsRequired`), CLI-resolved connections that go through `resolveMeshTarget` /
  `endpointAuth`, `cotal status`, `cotal web`, and the delivery daemon's three dials. It has not
  landed for the manager process, the user-auth service, the membership feed, `waitForDeliveryLease`,
  or the twelve helper sites tabulated above. That table is the residual enumeration; do not collapse
  it back to prose.

  The delivery daemon is strict on all three of its dials, including the every-two-seconds reachability
  poll that re-presents its standing credential for the life of the process.

  **Also not included:** the `cotals://` handout from `up`; a rotation command; and `tls://` as a
  _server_ scheme enforcing anything (it is cosmetic at the client: nats.js connects plaintext to
  `tls://host` with empty options, and only the explicit `tls` option refuses). **Changing transport
  on a live broker is restart-only by construction:** passing `--tls-cert/--tls-key` (or dropping
  them) against an already-running mesh is refused — `cotal down`, then `cotal up` with the desired
  flags. A reload of `nats-server` is not offered, because it would leave established plaintext
  sessions alive.

  Operators using a private CA need `NODE_EXTRA_CA_CERTS`, because `EndpointOptions.tls` is a boolean
  and cannot carry a CA file. The private-key permission check is POSIX-only.

  **S10 (fixed in this change):** a `tlsRequired` registry entry used to be **pruned** when a
  `connectOrExit` / `preflightOrExit` path ran without a trusted CA. `preflightTarget` probes with
  `{tls:true}`; certificate verification failure was classified as `unreachable` (prune:true), so
  `cotal send dm …` (and any other preflighted command) deleted a healthy mesh record on a recoverable
  trust error — durable state destroyed because the operator forgot `NODE_EXTRA_CA_CERTS`. Fix: when
  the recorded target requires TLS and the TLS probe fails as unreachable, confirm plaintext INFO
  still advertises `tls_required: true` (with a second, longer read before condemning); if it does,
  classify as `tls-trust` with **prune:false**. That proves a TLS-required NATS listener is present —
  INFO is unauthenticated and is not mesh identity — so the record is conservatively kept and the
  operator is told to fix the trust store (`NODE_EXTRA_CA_CERTS`). A plaintext substitute on the same
  port does not advertise `tls_required` and still follows the normal unreachable/prune path.
  Live-checked both ways.

  **Named follow-ups (not fixed here):**

  - Defence-in-depth only: pass `mesh.tlsRequired ? {tls:true}:{}` at `down.ts:418`/`:585` and thread
    transport into `:651`/`:691` (measurement showed bare INFO already enters the preserve-state
    quiescence gate when the CA is trusted).
  - Bare `cotal down` pidfile-trust: hiding manager/delivery pidfiles while those processes still run
    lets bare down stop the broker and report success (pre-existing; filed separately).

- 2768f5b: Contract schema registration is bounded structurally, and an unrecognised keyword is now refused.

  **This refuses more than before, and it can reject a contract that registered successfully in an
  earlier version.** `compileContract` is exported from `@cotal-ai/core` in the released package, so
  this is a break against schemas already in use, not an internal tightening. The 2020-12 execution
  profile (SPEC §13.7/§13.8) now validates a schema document
  against an explicit admitted vocabulary and raises `contract-invalid` for any keyword outside it.
  JSON Schema says an unknown keyword is ignored as an annotation; this profile refuses it, because a
  profile that enforces bounds cannot soundly bound what it does not recognise — counting only known
  keywords silently skipped `dependencies`, whose legacy schema form holds subschemas the walk never
  reached. The
  admitted set covers the full 2020-12 assertion, applicator and annotation vocabulary, so
  documentation keywords (`title`, `description`, `default`, `examples`, `deprecated`, `readOnly`,
  `writeOnly`, `$comment`) and the `$`-identifiers are all accepted; a vendor extension or a keyword
  newer than this release is not, and needs a line added to the profile. If you register contract
  schemas, check them against the admitted list before upgrading.

  Everything else in this change admits more, not less. The `maxSchemaNodes` and `maxClosureNodes`
  ceilings are removed: neither candidate basis for the constant survived measurement, since compile
  cost varies by an order of magnitude across schema shapes at one node count, and the compiler crash the bound was
  meant to sit below is not a stable edge (the same document threw on a cold compile and succeeded on
  the immediate warm retry in the same process). Registration remains bounded by document and closure
  bytes, structural depth, reference-chain depth, pattern complexity, the admitted vocabulary, and the
  compile-error catch that normalises any codegen failure to `contract-invalid`.

  The §13.8 compile and validate time budgets are reported rather than enforced. No instrument on the
  supported Node floor measures the intended quantity: elapsed time counts the whole machine, and
  `process.cpuUsage()` sums every thread in the process, so background JIT threads and sibling Workers
  are attributed to the compile being measured. Enforcing them refused valid arguments on the request
  path and refused a manager's own service contract at startup.

- 019afc3: The manager control surface gains three capabilities on the v0.4 endpoint rails: spawn as an action, multi-manager instance addressing, and attach as a mesh session.

  Spawn and launch are now actions (SPEC 13.6). Asking the manager for an agent no longer blocks the caller while the process comes up: the manager accepts a spawn goal and returns the allocated identity at once (`{name, owner, actor, uid, goalId, fingerprint, executor{lifecycleUid, epoch}}`), then progress events follow the launch to a terminal outcome. Presence within the readiness window settles the goal `succeeded`, an early exit `failed`, and the window elapsing with neither is `uncertain` (a bounded, durable outcome a later `ps` settles against the live roster, never a silent hang). A persona-derived name collision auto-numbers; a hard-pinned `--name` colliding with a live agent refuses at accept, before anything is minted. The `--detach` CLI spawn, the manifest `-f` launch, and the connector's `cotal_spawn` submit and follow to the terminal, so their behavior is unchanged. The goal terminal is fenced to the executing manager's own gate epoch (the terminal lands on an epoch-scoped result subject), so a superseded incarnation's terminal is invisible to current readers; a durable reconcile index lets a restarted manager settle any goal a predecessor accepted but never terminalized. The goal-fact writer is a dedicated, family-staged, renewed credential disjoint from the serve credential.

  One space can now run more than one manager. Each manager persists a stable logical instance id across restarts and advances its process epoch when it comes back, so peers address a specific manager regardless of which process currently serves it; a restart re-registers the same instance and evicts its predecessor's serve family through a scoped, one-registration eviction credential. `cotal spawn --on <instance>` pins one instance by its exact id, an untargeted spawn rides class anycast (the acceptance records which instance took it), and `cotal ps` / `status` become a class scatter that merges every registered instance's rows with per-instance attribution and labels a non-answering instance unreachable, never omitting it. The manager lease is demoted from a per-space singleton to per-instance liveness (loss stops only that instance's serving, never the space), reconcile touches only rows the instance owns, and the retirement rail authorizes on the registration gate rather than a name-derived holder, so a deposed predecessor cannot retire a target.

  `cotal attach` no longer returns a `127.0.0.1` websocket URL. It creates a one-use, holder-bound session over the mesh: the reply carries a signed session grant (no URL, never logged), redeemed once, after which terminal bytes stream on session subjects scoped to the two parties, with backpressure surfaced as an explicit drop notice. A late attach still repaints the full screen from a replayed terminal snapshot, and close, expiry, target despawn, and manager restart are distinct, surfaced end states. The browser console is now a real mesh session client over a served bundle (the broker gains a localhost-default websocket listener), holding only a per-session, rails-only credential that expires with the session. The manager's session writer is a scoped, family-staged, renewed credential over a dedicated sessions store.

- 3539f20: `freezeExpectedSet` and `epScatterService` no longer take a KV handle.

  The freeze enumerates via `STREAM.INFO` + `subjects_filter` and reads slots via leader-served
  `STREAM.MSG.GET` — both through the JetStream manager. The KV argument was unused after the
  enumeration conversion; callers that only opened a records bucket to pass it in can drop that open.

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

- 141c4dd: Read channel history through the delivery daemon instead of a consumer you create yourself.

  Reading scrollback used to require the reader to hold consumer-create on the chat stream. That is a
  lot of authority for a read-only surface: it is the one grant shape the protocol's mediated-reads
  rule says an untrusted holder should not have, since it addresses the stream directly rather than the
  messages you are allowed to see. A read-only dashboard or UI paid for a page of history with it.

  `readHistory` moves that read behind the delivery daemon, which already holds the trusted reader and
  the membership authority. The caller asks for a channel and gets its recent messages back; the daemon
  is the one holding the consumer. The caller cannot claim to be someone else — the daemon takes the
  principal from the authenticated request itself and ignores any identity in the payload.

  The reason this is more than a reshuffle is when authorization is checked. A consumer decides what
  you may read at the moment it is created and then keeps serving you, so revoking someone's access
  mid-scroll does not stop the pages already flowing. The daemon re-reads the caller's permissions from
  the durable registry on every single call, so a revocation stops the very next read.

  A page is the newest N messages, with a flag saying whether older history remains behind it, because
  "there is more above this" and "this is the beginning of the conversation" are different answers and
  a UI that cannot tell them apart will render the first as the second. Asking for a channel you may
  not read fails loudly, and so does a read that could not complete; neither comes back as an empty
  page, which would look exactly like a channel nobody has posted to.

  This is additive. Nothing is removed and no existing caller changes: reading history the previous way
  still works, and moving to the mediated path is a separate migration. Chat channels only.

  Authorization is the live registry row intersected with the mint-time ceiling. Revoking access
  (narrowing the live row) stops the very next page. Widening the registry without re-minting the
  caller's credential does not grant history the broker would still deny — the ceiling only rises
  when the credential does.

## 0.16.0

### Minor Changes

- 498055c: Stop paying one network round trip per record, and return the recent messages history claimed to return.

  Several read paths issued one sequential round trip per record, which is invisible against a loopback
  broker and ruinous on any ordinary cross-continent link. Measured against a mesh at 534ms RTT with
  healthy uplinks at both ends, reading the membership feed took 30 to 34 seconds for 89 entries; it
  now takes under a second for 93.

  - `liveKvEntries` is the one sanctioned full-bucket KV read: a single pass whose request count is
    independent of record count, which collapses by greatest revision with tombstones so a deleted key
    cannot resurrect, and which binds its own consumer so that an empty result is PROVEN by the
    bind-time pending count rather than inferred from silence. A pass that is cut short raises rather
    than returning what arrived. That distinction is load-bearing on the ACL path: read this way, a
    dropped link mid-scan would otherwise report a provisioned principal as having no ACL row, and a
    durable join would be refused as "not provisioned" instead of as "could not read". The membership
    feed, the members and channel registries, and the ACL alias enumeration all read through it. No
    change to broker authority: the same ordered push consumer over the same subject.
  - `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
    requested limit, while being documented as recent and rendered everywhere as the latest. They now
    return the newest, read through a bounded window rather than by draining the backlog.
  - `cotal status` started the Claude CLI twice for data one listing contains.

  Two optimisations were attempted and REVERTED during review, and are not part of this change: the
  dashboard's activity feed still fetches a full page per channel (the cheaper version dropped
  genuinely-newer messages, because saturation counts messages rather than recency), and control
  commands still open a probe connection before the real one (skipping it flattened typed auth
  failures and lost the probe's deadline).

  This is the read-path half of the work. The registry-safety half — a failed network probe must not
  delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
  `cotal meshes add`.

## 0.15.0

### Minor Changes

- f89560a: New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer, in Codex's own TUI. A host-mode peer drives a `codex app-server` thread over JSON-RPC: inbound batches wake a real turn, and directed messages steer INTO a live turn mid-flight.

  `cotal spawn --agent codex` opens Codex's own TUI. The app-server runs as a loopback websocket listener guarded by a per-incarnation capability token (0600, inside the agent's private home), and the TUI attaches to the very thread the mesh drives, so mesh turns render as they happen and anything you type is a real user turn on that same thread. With no terminal (piped output, CI, a smoke) the host stays headless with an activity feed instead; `COTAL_CODEX_TUI=1|0` picks the mode explicitly when the tty check would guess wrong. Once Codex owns the terminal the host's own log moves to `host.log` in the agent's private home, and the handoff line names that path so a later failure is findable.

  The shared `cotal_*` tools are served by the host process itself over a bearer-authenticated loopback MCP endpoint, with the token passed to codex by env var name so it never reaches the process table. Because the app-server is the MCP client, the same tools work on a mesh-driven turn and on one typed into the TUI; the connector's own tools are pre-approved so an unattended agent never stalls on an approval prompt nobody is watching, and `mcp_servers.cotal.*` is reserved and refused rather than silently overridden.

  Autonomy defaults suit an agent woken by peer messages when nobody is watching: `approval_policy=never` (never ask before running a command, not refuse), `sandbox_mode=workspace-write`, and `sandbox_workspace_write={network_access=true}`. Network is on because Codex's own workspace-write default has it off, which breaks installing a dependency or pushing a branch with an error that reads like the task is impossible rather than the sandbox refusing; filesystem containment is kept, because a peer's message is a remote input that can make the agent run commands. The network default is applied only where the sandbox is actually `workspace-write`, so tightening the mode does not leave a network grant in the launch. All three are overridable per spawn with `--opt` (including `sandbox_mode=danger-full-access` for no sandbox at all), while an interactive `approval_policy` is refused loud rather than auto-answered on the operator's behalf.

  The guide states the sandbox's guarantee literally: it blocks out-of-workspace local filesystem writes, and does not block reads, exfiltration, or networked side effects. With the network on, a peer-driven turn can read broadly and send what it reads, reach loopback and link-local services, and act through any credential it can read, including irreversibly, via a force-push or an API delete. Containing filesystem writes is not the same as containing damage, and the docs say so rather than implying the residual is disclosure-only. The offline, tighter-mode, and separate-OS-user mitigations are named in both the autonomy section and Limits.

  At-least-once delivery with exact-id acks on turn completion: a failed turn retries with backoff, an interrupt redelivers, and an app-server crash restarts the child in place on the same mesh lifecycle and re-drives the un-acked batch (a crash loop is fatal, never an endless respawn). Presence from the event stream, an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (a resumed codex thread comes up without its configured MCP servers, so the agent would be mute on the mesh) and tool-sharing.

  Also fixes the seed reconciler, which treated a generation match alone as up-to-date: a built-in connector added at an unchanged generation would never seed on an already-installed workstation (`--agent codex` reporting no connector installed). Both fast paths now also require every `SEED_BUILTINS` entry to be present in the ever-seeded set.

  A connector can now declare `launchHint`, the one line a foreground `cotal spawn` prints about what to expect next. That text used to be hard-coded to Claude Code's first-run gate for every agent type, telling operators of other harnesses to press Enter at a prompt that never appears.

  The web dashboard gains Codex branding (the OpenAI mark, from Simple Icons), so a codex agent renders with an icon and a label instead of a blank badge. That map was hand-maintained with nothing tying it to the connector set, so it is now covered by a test: every official connector must have a complete entry, and a new connector cannot ship icon-less with a green suite again.

## 0.14.11

## 0.14.10

## 0.14.9

## 0.14.8

### Patch Changes

- 84f6200: Per-agent `prompt:` in the mesh manifest — a kickoff message auto-submitted once the session is up, the declarative form of `cotal spawn --prompt`. Submitted on first boot and on stale-restart (hash-covered, so changing it marks a running agent stale); a reclaim of a still-live session does not re-submit. Imperative `--prompt` alongside a manifest launch is still rejected (one source). `topology view` marks agents that carry one.

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

### Minor Changes

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

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

### Minor Changes

- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.

### Patch Changes

- be66729: Add offline full-space and registry-only backup, preservation cuts, authenticated operation-isolated
  restore, conservative checkpoint recreation, same-principal resume, and explicit fallback cleanup.
  Remove the incomplete channel export surface.
- 47d2584: Foreground `cotal spawn` now provisions the full durable footprint (read-ACL row included), so a foreground agent gets the delivery daemon's durable backstop instead of silently running live-only and permanently losing every channel message posted while its connection blips. `--live-only` restores the old behavior explicitly. A foreground exit now also retires the agent's creds and broker footprint, mirroring the manager's despawn.

## 0.11.6

## 0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- 5634ae4: Keep quiet-channel ambient traffic pull-only across every connector.

## 0.11.3

## 0.11.2

## 0.11.1

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

## 0.10.1

### Patch Changes

- e3a53e3: Add a connector-agnostic model/variant selector: the `cotal models` command, a `--variant` flag on spawn, and the core `listModels` / `ModelCatalog` + `LaunchOpts.variant` contract. OpenCode discovers its models and variants from the installed CLI; Claude and Hermes reject variants (fail loud) and set `COTAL_MODEL` when a model is given.

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.

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

## 0.8.3

### Patch Changes

- a10ed79: OpenCode connector: mirror each agent's session transcript to its per-agent `tr-<name>` channel, event-driven from the plugin's in-process bus events (`message.updated` / `message.part.updated` / `session.idle`) — parity with the Claude connector, with no per-turn session refetch. The `tr-<name>` channel convention is exposed through the `Connector` contract (`Connector.transcriptChannel`) so the manager can grant the agent's publish ACL without the channel literal living in `@cotal-ai/core`, and the manager forwards control-plane `capabilities` (`COTAL_CAPABILITIES`) so a manifest-spawned agent exposes the `cotal_spawn` / `cotal_persona` tools its creds already authorize. Adds an end-to-end smoke for the mirror (`smoke:opencode-transcript`).

## 0.8.2

## 0.8.1

### Patch Changes

- 15fb826: Make credential-less `isReachable` a silent plaintext TCP+`INFO` liveness probe so it no longer logs a broker `authentication error` on every check (e.g. every `cotal supervise` start and registry prune sweep against an auth broker). It reads the server's unprompted pre-auth `INFO` greeting over a plain socket and closes before authenticating, so a live broker (open or auth) reports reachable with no auth-error/auth-timeout log line. The boolean result is unchanged for every caller; only the mechanism changes. `pruneStaleMeshes` uses the same silent probe; `probeConnect` and the with-creds `auth-required` classification are untouched. Limitation: the credless probe is plaintext-only — it returns false for a TLS-first (`handshake_first`) listener; the creds path stays a real authenticated connect.

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

## 0.5.0

### Minor Changes

- 58f2d41: Self-serve channel join + durable backstop (SPEC v0.3 delivery rebuild)

  Agents whose read ACL allows a channel now join/leave its **live** feed themselves over a native NATS core subscription — manager-free, broker-enforced by `sub.allow` (join = subscribe, leave = unsubscribe). A manager-hosted **Plane-3 durable backstop** (a privileged fan-out writer → a trusted reader that re-authorizes every entry against the current read ACL and membership interval → a per-member DELIVER durable the agent acks natively, SPEC §8) ensures a post still reaches a busy or offline agent on its next turn. Channel membership moves to a privileged cursored KV registry (`cotal_members_<space>`), and channels carry explicit `live`/`durable` delivery classes (default `durable`; a space with no manager is live-only).

  The legacy per-instance `chat_<id>` live-tail durable and the mediated filter-move are removed — one clean model with no coexistence code. This is a wire-protocol change (SPEC bumped to v0.3): new and old clients do not interoperate on channel delivery.

## 0.4.0

### Minor Changes

- 878f406: Broker-enforced channel read ACLs, self-healing connections, and control-plane primitives

  - **Channel read ACLs.** Splits the overloaded agent-file `channels` / `publish` fields into
    three explicit concepts: `subscribe` (active read set), `allowSubscribe` (read ACL), and
    `allowPublish` (post ACL, default-deny), with the invariant `subscribe ⊆ allowSubscribe`
    enforced fail-loud at load and provision. The chat read/write boundary is now genuinely
    server-enforced (like DM/TASK): bind-only live-tail durables so an agent cannot widen its own
    filter, name-scoped history reads, per-channel read grants pinned to the request subject, and
    default-deny publish. A follow-up review closed an ACL token-aliasing hole (a policy channel
    must be a NATS-safe token) and dropped unused DM/TASK `STREAM.INFO` grants so subject metadata
    no longer leaks across peers.
    **Breaking:** the loader rejects the old `channels` / `publish` field names rather than
    silently dropping scope — migrate agent files and personas to `subscribe` / `allowSubscribe` /
    `allowPublish`. SPEC and docs are updated in the same change.
  - **Self-healing mesh connection.** The endpoint rebuilds itself on a terminal NATS close —
    unacked messages redeliver on the rebound durables, so nothing is lost across the gap — plus a
    manual `CotalEndpoint.reconnect()` (serialized against the supervisor and retry loop, with an
    interruptible backoff) and a new endpoint `connection` event.
  - **Control-plane subjects.** Adds the self-service / privileged / admin control-subject tiers
    and threads authenticated `req.from.id` through control handlers.
  - **Fixes.** Wildcard channel subscriptions now work (`c` + `c.>`); peer-name resolution is
    deterministic and fail-loud.

## 0.3.2

## 0.3.1

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

## 0.1.3

### Patch Changes

- b3a790e: Grant `$JS.API.CONSUMER.DELETE` on the CHAT, channel-registry KV, and DM streams in the minted agent/observer/admin permissions, so ephemeral consumers can be torn down under scoped creds.
- 739649a: Spaces model, operator console, cmux onboarding, personas, and faces (PRs #15–#20).

  - **cli** — a lazygit-style Ink `console` over a shared `MeshView`, plus `setup`/`supervise`/`cmux`/`demo` onboarding.
  - **manager** — registry-resolved runtimes (the manager no longer depends on cmux), graceful stop, and `definePersona`.
  - **cmux** — a self-registering `cmux` `RuntimeProvider` with real teardown.
  - **connector-core** — `cotal_persona` and `cotal_despawn` tools.
  - **connector-opencode** — an optional animated face viewer (avatar id read from the agent file's `meta.face`).
  - **core** — space discovery (`listSpaces`/`deleteSpace`), a pluggable `Runtime` extension contract, `DEFAULT_SPACE`, `saveAgentFile`, and a generic `meta` passthrough bag (kept a patch to avoid force-majoring the connectors that peer-depend on core).

## 0.1.2

### Patch Changes

- 5f9e171: Publish all packages: add repository field for OIDC provenance, plus in-flight changes (cmux runtime exec-via-env fix, manager runtime selector, .gitignore product/, etc.).

## 0.1.1

### Patch Changes

- 18c271f: Publish all packages: configure GitHub Actions changesets workflow with npm OIDC trusted publishing.
