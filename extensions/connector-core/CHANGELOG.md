# @cotal-ai/connector-core

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

### Minor Changes

- a71fbd3: A failed turn is published as a run error, so a reader of an event plane can tell a turn that failed from a turn that finished.

  Every connector used to close a run with `RUN_FINISHED` whichever way the turn ended, including a
  turn its own harness had already classified as failed. `RUN_ERROR` was in the vocabulary, the
  bracket machine accepted it as a close and the dashboard rendered it, but the shared close path had
  no way to say it.

  The close on the shared emitter and holder now takes an optional failure, and two connectors supply
  one from a record they actually receive. Claude Code ends a failed turn on its own `StopFailure`
  hook, and that turn now closes with `RUN_ERROR` carrying the harness's error kind (`rate_limit`,
  `billing_error`, `server_error` and the rest) as the code. OpenCode reports a dead turn on
  `session.error`, and that turn now closes with `RUN_ERROR` carrying OpenCode's own error name and
  reason, except a turn a person stopped, which arrives on the same event and is not a failure.

  The shared close also bounds that failure detail. Upstream free text (`error_details`,
  `data.message`) can encode past the live frame ceiling; packing it as-is used to refuse the close
  before any terminal became durable and then permanently kill the holder. The close now rebuilds the
  one `RUN_ERROR` so it fits, keeps the code, and the emitted message says the original detail was
  omitted or shortened because of the bound. A short message is unchanged. There is no second protocol
  and no per-connector size table: every producer already goes through this close.

  Deliberately not built: connector-specific caps, a second close method, preview-plane truncation on
  the durable path, and any change to `packUnits`'s fail-loud rule for source observations. Those would
  not close this hole and would duplicate a contract that already has a caller.

  Migration: nothing is removed and no existing call changes shape. A consumer that only handles
  `RUN_FINISHED` now sees fewer of them on failing sessions; the event type it needs to also handle
  has been part of the vocabulary and accepted by the bracket machine all along.

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

- 7bc71ab: Serialize the top-level session swap. The plugin bus does not await the event handler, so a second
  top-level session created while the first swap is still draining captured the same holder to
  retire and installed its replacement over the first one. The dropped replacement had already been
  adopted, which is where its write-ahead log and subject frontier are opened, so it was orphaned
  with an open handle and the session it held left a run open on the wire with nothing reporting it.
  The holder they both replaced was drained twice.

  Swaps now run one at a time, so each reads a holder that is installed and no longer being retired
  underneath it, and the chain carries the absorbed tail of each swap, so the next one still runs
  after a failed drain.
  Installed rather than settled: a swap waits for the holder it RETIRES, not for the one it installs,
  whose adoption is still starting when the swap resolves.
  The connector also logs a retirement the way it already logs an adoption, which is what makes a
  retirement that never happened visible at all.

  Serializing the swap was not enough on its own, because the session id and the holder that serves
  it are two separate things and an event could arrive while they disagreed. Ordering them only moved
  the window: with the id assigned before the drain, an event in the gap was carried by the new id
  into a holder still bound to the previous session, and that holder refuses a second session
  permanently, so the event plane died rather than skipping a frame. Event work is now routed by
  asking the holder what it is bound to, so an event reaches a holder only when that holder already
  serves its session or serves nothing yet.

  A session that OpenCode attaches to, rather than creates, is also covered. The first event of such
  a run arrives before any session was created, and it now reaches the event plane instead of being
  dropped, so an attached session publishes from its first turn rather than staying silent until the
  next reset.

  Stopping a seat is now a teardown rather than an exit. The cooperative stop and the editor
  unloading the plugin run one shared routine, so neither can drift from the other, and it attempts
  the offline publish in front of the join rather than behind it: a supervised seat is hard killed after
  its runtime's grace window, so presence queued behind a long drain is the thing that gets lost.
  Queued event work is then given a bounded chance to settle inside whatever time the runtime leaves.

  Once that routine has begun, the connector starts no turn of its own, admits no hook work, and
  runs no `cotal_*` tool call. That first part now holds for a drive that was ALREADY PAST the check
  as well, which it did not before: the guards were read once, session creation was awaited, and
  nothing looked again, so a turn admitted while the seat was healthy could be submitted after
  departure had published. The phase condition is one predicate now, read on the way in and again on
  the way back from that await, and a drive refused there consumes nothing, so the batch is still in
  the inbox for a later wake in the same process.

  Separately, the operator's spawn prompt is no longer lost when something else gets in front of it.
  The boot task used to clear the prompt and then ask for a turn; if a natively submitted prompt had
  already made the session busy, that request returned early and the text was gone. The text is now
  cleared only once it has actually been submitted, and it counts as pending work everywhere the
  connector asks whether there is anything to drive, so being beaten to the session costs a retry
  rather than the prompt. What it does NOT do is cancel the editor. A hook steers
  OpenCode by mutating its `output` argument rather than by what it returns, and `chat.message`'s
  output carries no field that cancels or skips a turn, so a prompt submitted natively through the
  editor or its API still starts one. Whether that turn's events reach the plane is timing rather
  than a rule: the endpoint stays up until the end of the routine, so work already queued can still
  settle, while work arriving after the fence closes is refused. The refusals are stated as a condition on the state rather than as a list of the callers
  they cover, which is what let the earlier versions through: a turn could still be started by the
  deferred drive a swap fires when its own cutover completes, a late presence event could put a seat
  back on the mesh it had just left, and a tool call already inside the model's turn had no way to
  know a stop was running. A refused tool call says so rather than returning nothing, because its
  caller is waiting on a result and silence would read as a hang.

  The same loss had one more door, and that one is a failure rather than a refusal. Every refusal
  above leaves the drive through a guarded return, where the input it was carrying is put back by
  hand. A submission the host rejects leaves through the error path instead, and that path put nothing
  back. It looked safe only because most inputs are parked somewhere else already: the wake for an
  @mention in focus is not, because its body is acked at ingest and stays recallable while the wake
  itself lives only in the string handed to that one drive. So a rejected submission destroyed the
  wake, and the retry that exists for exactly this case then saw no pending work and did not run,
  leaving a seat that was never told to go and look. The error path now parks its input like every
  other exit, so a failed submission costs a retry rather than the wake.

  One slot, and one caller clearing another caller's wake. The three exits above each put their input
  back by hand, but they all put it in the SAME place, and the clear that runs after a successful
  submission sat on the far side of an await. A drive parked in session creation had read its input
  before that await; a second caller then reached the entry guard, parked its own wake in that slot and
  returned; and when the first call finally submitted, it emptied the slot on the strength of what IT
  had taken. That is a lost update across an await, and it destroyed a wake that arrived through
  exactly the guarded exit these changes exist to protect. The clear is now ownership checked, by
  generation rather than by value, because the nudge names the sender and not the message, so two
  mentions from one sender are byte identical and comparing them would report "still mine" about
  someone else's input.

  A wake could also be destroyed before it ever reached that slot. The handler for an @mention in
  focus declined to ask for a turn while one was already running, which is the right thing to do one
  handler above it, where the message is buffered in the inbox and the next turn picks it up. This
  one has nothing buffered behind it: the body is acked and dropped as it arrives, so the nudge is
  the only copy, and declining did not defer it, it discarded it. The turn then ended, found nothing
  pending, and the seat was never told it had been mentioned at all. That wake is now handed over
  whatever the seat is doing, so a busy seat parks it and drives it when the turn ends.

  What that does and does not promise, stated narrowly on purpose. It does NOT prevent message loss:
  an @mention in focus is acked at ingest, and where the channel permits replay its body stays
  recallable from the server, so the content was never riding on the wake. Where a channel denies
  replay, the body is gone by that channel's own policy and no wake can bring it back; the connector
  deliberately does not buffer it, because doing so would hand a seat in focus history that the
  channel refuses to everyone else. What this prevents is a caller's wake being erased, whether by an
  unrelated call's clear or by a handler that never passed it on. One slot is the design rather than
  a limit: a later wake overwriting an earlier one costs nothing, because any single wake that fires
  makes the seat pull its inbox and recover whatever that channel will give back, while emptying the
  slot entirely means no pull is ever triggered. The invariant is that at least one wake survives to
  fire, not that every wake is kept.

  Departure is also ordered behind the work the seat has already admitted, for as long as a short
  bound allows. A presence write is not atomic, so a call admitted before the stop could be parked
  mid-write while the teardown published offline, and then put the seat back to work after it had
  announced it left; on the wire, a roster read `working` after `offline`. The teardown now waits,
  briefly, for interactive work it has already admitted before it attempts departure, and joins the
  slower event work afterwards as it already did. Event work is deliberately not in that wait,
  because waiting on a drain is what publishing departure early exists to avoid.

  That wait is for the whole admitted set rather than for the first thing to happen to it, and it says
  so with `Promise.allSettled` rather than by absorbing each call by hand. The hand-rolled version was
  the same defect one level up: a map can absorb SOME elements, and a review proved by live mutation
  that absorbing only the two ends passed every cell the suite had at the time. The primitive waits for
  every element and never rejects, so partial absorption is no longer a state this code can be in.

  That wait is bounded below the shortest runtime grace window, which is what leaves room for
  departure to be published before a hard kill under ordinary conditions. It is a margin rather than
  a guarantee: the publish itself has no deadline, so a slow write in the time the bound leaves is
  lost with everything else the kill takes. The other tradeoff is stated rather than implied: a
  straggler that outlives the bound is not cancelled, so it can still complete after departure has
  been published.

  A wake that arrived before the boot prompt used to starve both of them, permanently and silently.
  The two share one slot: the boot text was carried only when that slot was empty, so a focus
  @mention landing while the boot task was still waiting for the session parked the nudge, and the
  boot task's own request then read that nudge, put it straight back and returned. Nothing could
  empty the slot afterwards, because emptying it takes a submission, a submission takes the boot text
  cleared, and clearing it takes the submission that had just been refused. The seat stayed online
  with nothing logged and no retry scheduled, and it went deaf: the spawn prompt, the wake, and every
  later connector-submitted turn including a directed message were all lost for the life of the
  process. Against the previous release this was a regression, which lost the wake and still
  submitted the boot. The two now go out together in one turn rather than competing for the slot. The
  boot floor says the operator's prompt is the first turn this connector submits, and a wake says
  only that the seat should go and look, so there is nothing to order between them.

  The event plane also gives back what a session took on disk, which is the other half of a `/new`
  and the half that is not visible on the wire. Two things are created for a session that publishes
  events and they have different lifetimes, so they are released differently.

  The principal lock is per principal and per workspace, shared by every session of that agent. It
  was taken and never given back: the connector read the location it came with and dropped the lock
  itself, so nothing in shipped code released one. The record then went on naming a process that was
  alive and no longer publishing, and a REPLACEMENT process for the same principal was refused its
  own event plane. It is now released at the final event teardown and only there, since a `/new`
  must keep it for the session that follows. Both ways out reach that teardown, so the editor
  unloading the plugin while its host keeps running releases it exactly as a supervised stop does.

  A session's write-ahead log is per session and its lifetime is stated rather than assumed, because
  a log exists so a later start can recover what was not yet published and deleting one early
  destroys exactly that. A retired session's log is removed once its run has been closed on the wire,
  AND the drain that closed it settled rather than spending its bound, AND the log holds no frame the
  broker never confirmed. Either of the last two keeps it, for different reasons that the connector
  distinguishes in what it logs: an abandoned drain is uncancelled and may still be writing, while a
  pending frame is the one thing only a later start reading that file can settle. The live session's
  log survives teardown, because a teardown is not a retirement: nothing has told an observer that
  thread ended, and a start that adopts it again is the case the log is for. So a process leaves one
  log directory behind rather than one per `/new`.

  `@cotal-ai/connector-core` gains a close on the emitter holder to go with that. Retiring a holder
  was a dropped reference rather than an act: it refused nothing afterwards, and a late hook could
  still start or pump an emitter its owner had finished with. Closing refuses admission and then
  joins what is already queued. It cancels nothing and releases no durable state, because the log's
  lifetime and the lock's are the connector's to decide and not the holder's.

- a999a98: The advertised tool surface and the orientation card now gate on **authenticated**, not on "has static creds", so a user-auth agent is no longer told it can spawn.

  `cotal_spawn` and `cotal_persona` ride the `spawn` capability, and the gate read `!config.creds` as
  "open mode". That was true while there were two identity states. There is now a third: user-mode
  auth. It carries no static creds by construction; the pair is refused at parse, at launch, and
  at connect, one launch carrying one identity plane. So `!config.creds` was always true on a user-auth
  agent, and every agent on a user-auth mesh was advertised both manager-op tools whatever its
  capabilities. The wire still refused the call, so nothing could be done with them; what broke is the
  guarantee the gate exists to keep, that an agent sees these tools only when it can actually use them
  rather than discovering the denial by trying.

  The orientation card was wrong twice on such a mesh. It listed both tools, and its access line said
  `open mode (grants advisory, host-trusted)` for a mesh whose grants are broker-enforced. The tool
  list is corrected by the wire the moment an agent tries; a card that misstates the security posture
  is corrected by nothing.

  Both sites now call one exported predicate, `isAuthed(config)`, mirroring the endpoint's own
  open-vs-auth gate, so a third identity plane is one expression to change rather than a search.
  `token` / `user` / `pass` are deliberately excluded: shared-token auth carries no owner+actor grant
  and no per-agent publish ACL, so the broker gates nothing per agent for it and hiding the tools there
  would be the same untruth in the other direction.

  Open mode is unchanged in both directions: no identity plane means everything stays visible, exactly
  as before.

  Migration: an agent on a user-auth mesh without the `spawn` capability no longer sees `cotal_spawn`
  or `cotal_persona`, and its orientation card now reports auth mode. Granting the capability restores
  both. Static-creds and open-mode agents are unaffected.

- 316f84d: Cap the dashboard delete route's request body at 8 KiB.

  `POST /api/channel/delete` read its body with no size limit and no look at `content-length`, so the
  ceiling on a request was the process heap: a 30 MB post was read in full, answered with a 70 MB
  refusal, and cost 1.39 GB of peak RSS before the route formed any opinion.

  The read now refuses at the threshold with a `413` naming the limit and the size that met it, on
  both the declared length and the bytes as they arrive, so a body with no declared length is capped
  too. It is never truncated to fit: a shortened channel name is a name the caller did not send, which
  is the aliasing shape this route's validator already exists to refuse. Bodies under the cap, extra
  fields included, are untouched.

  The refusal also closes the connection the oversized body arrived on. Without that, a caller asking
  to keep the connection alive still got to send every byte, because the server reads the rest of a
  body to get the socket back for reuse: the refusal was early but the work was not bounded. Ordinary
  within-cap requests keep their connection and their socket stays reusable.

  `@cotal-ai/connector-core` is listed because it ships the docs bundle, which embeds the page this
  change updates and is regenerated here. Its only diff is that regenerated file.

### Patch Changes

- 29c5268: A peer flooding a channel can no longer silence directed mail. The inbox overflow valve sacrificed
  pull-only backlog first, but pull-only requires a non-forgeable signal it did not have: it is
  `!mentionsMe && historical`, and `mentionsMe` is read from the payload `mentions` field, which the
  sender controls. A peer stamping the victim's name on every flooded message made none of its traffic
  pull-only, so eviction fell through to the oldest entry, which is the message that had been waiting
  longest, and acked it without marking it handled - unrecoverable, since the broker then never
  redelivers. Ordinary ambient channel traffic at volume did the same with no forgery at all.

  Eviction now prefers channel traffic over anything addressed to this agent, reading directedness
  from the subject-derived `kind` rather than from the payload, and a directed message that must be
  sacrificed is left un-acked so it can be redelivered. Channel ambient is still acked, because
  replaying it is what the earlier history flood was.

- b8ee849: Announce the operator-global seed-store payload write, and its deletions, on the provenance channel. `cotal up` and the built-in-connector reconcile re-seed `~/.config/cotal/seed/store/<version>`, which is a machine-wide action (shared by every space, project directory, and checkout on the machine, moved only by `$XDG_CONFIG_HOME`), yet the store write was previously silent. It now emits a `wrote operator-global seed store payload` provenance line naming the path on each materialization, so re-seeding from a non-released checkout reads as the machine-wide write it is. The idempotent reuse path stays silent.

  The same reconcile also garbage-collects unreferenced store generations, and that was silent too. A new `removed` verb on the provenance channel names every directory the collector deletes, because a silent delete is worse than a silent write: the write at least leaves the thing it made, while the delete leaves nothing to notice. The announce rides stderr with no failure policy, so a closed stderr keeps the write and loses the line; that bound is stated at the call site and in the config reference, which also documents the isolation mechanism.

  The config reference that documents all of this ships inside the connector as well as in the docs tree, so the regenerated documentation bundle carries the same text: an agent asking `cotal_docs` for the configuration page now gets the announce, the removal announce, and the stderr bound along with everything else that page already said.

- 1f44ca6: Add an optional reverse-proxy-facing auth exchange listener with generated mesh discovery, credential-based public proof, isolated throttling, and `cotal up --user-auth` configuration.
- 4f7747f: The block that carries peer messages into a turn now names the order of operations rather than only
  the reply verbs: do the work with your own tools, verify it, then reply, and never report an action
  that was not performed. A delivered peer message is frequently a work order, and its tail arrives at
  the moment the model chooses what to do next, so a reply-only tail reads as an invitation to answer
  instead of to act.
- e26f4d1: Allow an already-granted managed agent to refresh its bearer through a pinned HTTPS public exchange URL without local auth-service state or capability material.
- 200a93f: Enable remote user-auth mesh registration now that managed agents can consume the recorded pinned exchange and sentinel through the remote bearer client. Remove the temporary development-only registration hatch and its fail-closed sequencing refusal.

## 0.27.0

### Minor Changes

- 0aed7fa: Historical channel ambient is now buffered pull-only: a join backfill is delivered as recallable context instead of automatic turns, so a seat joining a long-lived mesh no longer receives the channel backlog as a storm of instructions. Historical @mentions and DMs keep automatic delivery, and live ambient is unchanged.

## 0.26.0

### Patch Changes

- f339690: Document capability handles as a distinct cost of default environment inheritance, and make two env-boundary suites real gates.

  The configuration guide told operators that `spawn.env` protects secrets living only in the environment, and reassured them that a shell reads `~/.ssh` either way. That understates what inheritance forwards. `SSH_AUTH_SOCK` names a live `ssh-agent` rather than holding a secret, so an inheriting child can ask that agent to sign for any key it holds, and it keeps that power when no private-key file exists on disk at all. The guide now names capability handles as their own class, states the `ssh-agent` case, and records that model-catalog discovery in the `codex` and `opencode` connectors runs the harness with the operator environment and does not consult `spawn.env`.

  The environment-boundary suite asserted that an unenumerated `COTAL_*` sentinel was absent from a spawned child, but never set it in the parent, so the assertion could not fail. The sentinel is now injected, which makes the cell prove the reset is driven by the prefix rather than by the enumerated per-session list. `smoke:hermes-launch-env` and `smoke:env-isolate` are both added to the sharded CI suite list; the hermes suite carries the connector's inherit, reset and both-containment-mode coverage and was previously reachable only through a package-local command.

## 0.25.0

### Minor Changes

- 17f8c57: OpenCode sessions publish AG-UI events, so a seat's work is readable by a program rather than only by a person.

  A session spawned with `--events` now publishes run boundaries, assistant text, reasoning and every
  tool call with its arguments, its end and its result, on `events.<owner>.<actor>`. Until now only
  Claude Code did; an OpenCode seat's event panel was empty.

  Migration: nothing is removed and no behaviour changes for a session that does not ask for events.
  A personal `opencode` with the plugin installed still publishes nothing, because arming is
  `COTAL_EVENTS` and the launcher sets it only for a `--events` spawn.

  Two limits are deliberate and documented. No user-authored text is published: OpenCode injects a
  peer batch by prepending it into the human's own text part, so one record holds both authors with no
  boundary in it to filter on, and guessing where one ends would fail open the moment either formatter
  changed. And no step events or usage numbers: OpenCode's step records carry no step name and no key
  shared between start and finish, and what the finish carries is cost and tokens, so emitting a step
  boundary would tell a reader that a phase ended when what happened is that counts arrived.

  One OpenCode process can hold several sessions, and `/new` is a context reset that keeps the mesh
  identity. Each session publishes under its own thread id on the one channel. The session being left
  is flushed and its open run is closed before the switch, so a reader is never left holding a run
  that never ends.

  The reader is the same on every connector, so the channel, the grant and how to subscribe are
  documented once in the Claude Code page and linked from the OpenCode one.

  `@cotal-ai/connector-core` is listed because the generated documentation bundle it carries is
  regenerated with the pages.

- aa6c63d: Codex seats publish an AG-UI event plane

  A Codex seat launched with `cotal spawn --events` now publishes a structured account of its work on
  `events.<owner>.<actor>`: run boundaries per turn, assistant text, reasoning summaries, and the tool
  calls the model makes through Codex's function-call and custom-tool interfaces, each with its
  arguments, its end, and its result. Before this the connector had no event plane at all, so an
  external observer watching a mesh saw nothing from a Codex seat.

  The durable source is the thread's rollout file inside the seat's own isolated `CODEX_HOME`, not the
  live app-server stream. The file is written by the child and outlives this process's view of it, so a
  seat that restarts its own app-server picks a thread's records up where it stopped rather than from
  whatever the socket delivers next.

  Four behaviours are worth knowing before reading a stream. A turn that fails ends its run with a run
  error carrying the code Codex reported, rather than as a finished run, because Codex records a
  failure on the turn's own completion record. No user authored text is ever published: your prompts,
  the peer messages injected into the thread, and the persona's developer instructions are all
  withheld, because the events channel carries a different read ACL from the channel you typed into.
  A restarted app-server is a new thread and gets a new stream: the seat finishes the old one, closing
  any run it left open, before it begins the new one. That holds even when the new thread's file is
  slow to appear, though the order there is the other way round: the seat spends its whole bounded
  look for the successor first, and the old run is closed when that look gives up, not at the moment
  the restart happened. From the give-up on it publishes nothing until a later turn boundary binds
  the successor, rather than continuing to report the dead thread's activity as if it were live. And Codex's own built-in tools, web search, tool
  search and image generation, are not published, because their records carry an end with no start and
  no key that joins the halves.

  What is published is worth stating plainly: an observer of the events channel sees every tool call's
  arguments and outputs verbatim, so withholding user authored text does not make the stream safe to
  widen.

  Two limits are worth knowing as well. A stream begins at the last complete record in the file at the
  moment the seat binds to it, never at the beginning of the thread, so anything written before that
  moment is not republished; the seat says so in its log when it happens. And a seat whose broker was
  unreachable when it started loses its emitter, reports that it did, and rebuilds it at a later turn
  boundary once the broker is there, so the outage costs the turns it covered rather than the rest of
  the seat's life.

  Migration: none. The plane is opt in per spawn, arming is separate from authorization, and a seat
  launched without `--events` behaves exactly as before.

- a4e4c49: Codex event plane: take the stream's starting boundary at the bind, not when the emitter finished starting

  An armed Codex seat announced its stream as started at the bind, then positioned itself wherever the
  rollout file happened to be once its asynchronous setup had finished: the write-ahead log directory,
  the subject frontier, the log open, then a channel resolve and a preflight. Every record the thread
  appended inside that window landed behind the cursor and was treated as already published, so a turn
  that completed inside it was dropped permanently and silently, underneath a line that had already
  said the stream was live. The boundary is now captured at the bind, before the announcement, and
  substituted on the emitter's first read, so the announced fact is true at the moment it is
  announced. A log that already carries a cursor is a resume and keeps it, because a cursor written by
  a live emitter is the honest one.

  It is substituted rather than written into the log, and that half is what keeps a failed start from
  changing what a later one publishes. A seat whose broker is not up yet loses its emitter at launch;
  a boundary written into the log before that start would outlive it, and the next bind would read it
  as a resume and republish everything the thread wrote while the seat was cut off, onto an events
  channel whose read ACL is not the input channel's. The log's cursor is now written only by an
  emitter that started.

  Migration: a rebind after a lost connection declines to publish two things, and readers who watched
  the old behaviour should expect both. It declines what the thread wrote during the outage. It also
  declines the turn whose own boundary triggered it, because Codex writes a turn's first record before
  it announces that the turn started, that announcement is what a rebind runs on, and a run is never
  opened from the middle of a turn. The first turn to start after the rebind is published in full.
  One case is different and is stated in full rather than in passing, because it is the one a reader
  is most likely to be surprised by: if the emitter had already been publishing this thread and then
  died, its position is in the log, and the rebind continues that log rather than starting where it
  binds. An outage there costs the wait, not the content: what the thread wrote while the plane was
  down, and what it wrote while the plane was already dead, is delivered once the plane is back. Two
  things follow that a reader should not have to discover. A tool result is published as the tool
  returned it, so text a tool read on the seat's behalf from a channel with a narrower reader set
  crosses into the events channel unredacted and unattributed; and a backlog written while the plane
  was terminal is delivered rather than discarded. The session's own record of the user's words and
  the developer instructions is not published in either case. Neither carrier is introduced here and
  neither changes shape; both are the same at the merge base and no new shape is added. What this
  change does alter, on every armed seat and not only the one whose emitter never started, is which
  records reach the stream: what the thread appended between the bind and the emitter's first read
  used to land behind the cursor and be dropped, and it is published now. A whole turn can sit in
  that window, tool results included, so the carrier above covers a stretch of the session it
  previously lost. The reader set that follows from all this is a requirement and not a guarantee:
  the grant does not enforce it. A spawn through the manager gives a seat publish rights on its own
  event channel and nothing else and a spawn naming a different agent's is refused at the door, but
  that fence is the manager's, it reads the concrete form rather than a pattern, and a foreground
  spawn on your own machine grants whatever you name. Read access is minted separately and out of
  band either way, so holding the events readers to at least the width of every channel the seat's
  tools can read is the operator's policy to keep. Nothing is sent twice in either case. A seat launched
  without the event plane armed is unaffected.

  The window above is now graded rather than argued. A test-only setting widens the emitter's setup
  so a fixture can release a whole completed turn into it and assert the turn reaches the wire;
  absent, empty, zero, negative and unparseable all mean no wait, so an uninstrumented seat runs the
  path it ran before. Measured, and the reason the cell was needed: the mutant that deletes the
  boundary rule passed the suite three times in five without it, failing on disjoint cells the two
  times it failed.

- b31d2af: Drop `NEBIUS_API_KEY` from the model-provider allow-list. How a harness authenticates to an
  inference provider is the harness's business, not Cotal's: OpenCode, Codex, and Hermes each
  have their own provider config and credential store, and Cotal carrying a per-vendor env name
  meant every new inference provider needed a change here to work through a managed spawn. The
  Token Factory operator guide goes with it.
- 838c01e: `cotal_inbox` clears only the messages it actually returned, so a recovery read can no longer consume mail it never delivered.

  The read is destructive, recovery is when the payload is largest (reconnecting brings a channel-history
  replay with it), and a payload can exceed what the host will hand to a model. Composed, the first pull
  after a reconnect marked a real direct message read inside a response nobody received. Measured before this change: 200 messages, 463,788 characters, one call, inbox left at zero.

  Now one call carries at most a receivable window and acks exactly what it rendered. Direct messages and
  role requests take the window ahead of channel traffic, with replayed history last, so first-party mail
  is not the thing a backfill crowds out. Whatever does not fit stays buffered, unacked and named in the reply, and comes back on the next call. `peek: true` still clears nothing, and is now bounded too.

  A message larger than one whole response is never consumed. It is named in the reply with its sender and
  size and left buffered, because a payload that cannot be delivered must not be cleared. The rest of the
  buffer flows past it, so one such message wedges nothing else.

  Focus recall is walked by this session's own mark, and a sender's clock cannot move it. A recalled
  item carries the timestamp the sending endpoint stamped, so one peer running ahead, or one writing
  whatever it likes, could park the mark in the future and filter every ordinary message after it out
  of recall for the rest of the session. Items at or behind the local clock are ordered by timestamp
  and move the mark; items ahead of it are handed over once, tracked by id, and never move it, under a
  bound whose cost falls on the sender that spends it.

  A response that must choose between carrying a message and describing the ones it is not carrying
  carries the message. The held-note gives up its names, then its counts, then itself, rather than let
  a message that fits in the window go undelivered because a note about an undeliverable one was
  riding beside it.

  A peer cannot write the reply's own framing. Every byte of a `cotal_inbox` reply is assembled from
  text a peer controls, and the reply is structured: a head line, one line per message with its sender
  in brackets, then the held-note and any warning. A message carrying newlines was writing that
  structure itself, forging a second message line attributed to another named peer, the held-note with
  its call-again promise, and the recall warning. A sender name, a service name and a channel label
  could each close their own bracket the same way.

  A line that begins at column zero is now written by the tool and never by a peer: one message is one
  line plus indented continuations, and every peer-controlled field rendered into the frame carries
  neither a closing bracket nor any character a line splitter may honour. The neutralization lives in
  one helper, so the wake hints the Claude Code, Codex and OpenCode connectors build from a peer name
  are covered by the same rule.

  The focus recall mark is forgotten whenever the frontier under it changes. It records a position in
  one walk over one frontier, and entering or leaving focus replaces that frontier, so a mark left from
  an earlier episode was filtering a new episode's messages out of recall whenever they were stamped
  behind it.

  Migration: a caller with a large backlog now needs more than one `cotal_inbox` call to empty it, and the
  reply says how many messages are still held. A multi-line message renders with its continuation lines
  indented by two spaces, and a name, service or channel containing `]` or a line separator renders
  those as spaces. Nothing is dropped, nothing is truncated, and no argument changed.

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

- 34caaf4: Agent seats no longer export their connection material into the environment every descendant
  process inherits. The broker URL, the creds path, the auth token, the user-mode identity and the
  local control token now ride a private 0600 launch-material file whose path is the only thing in the
  seat's environment; pi, codex and OpenCode drop even that path once they have read it (for OpenCode
  that happens in the `opencode serve` process its seat shim starts, which is also what runs the
  session's tool calls), while claude and hermes keep the reference because their readers are
  short-lived children that start later. A session driven by hand still sets `COTAL_CREDS` / `COTAL_SERVERS` itself, and a
  launch that carries both carriers is refused rather than resolved by precedence.
- 6959679: The dashboard survives a poll that fails, and its aggregation answers instead of failing.

  A failed poll used to clear the peers and the channels. A 500's body is valid JSON and `fetch` does
  not reject on one, so the refusal arrived as a successful parse and was stored as the snapshot. Reads
  now refuse a non-200 by name, a refused read leaves the value the page already holds exactly where it
  is, and the header says which source is stale and why. Recovery is the next successful read.

  `/api/activity` no longer fans out every channel's history at once with no upper bound, where one
  channel's rejection became the whole route's 500 and a slow link produced a 34-second success.
  Sources race one shared deadline through a bounded pool, and the page always carries `partial`, the
  counts, the named missing sources, and the deadline it used, so a short page cannot be mistaken for a
  complete one. `/api/dms` is one read with no subset to serve, so its bound is a 503 that names the
  deadline. A channel list that cannot be read is a refusal that says so rather than a page claiming
  the space is empty.

  The elevated observer/admin credential can now delete consumers on its own presence bucket. A KV
  watch rebuilds itself when the link stalls and each rebuild deletes its predecessor; without that
  grant the cleanup was refused, so orphaned consumers accumulated until their inactivity threshold and
  the broker logged a violation every time.

### Patch Changes

- 0b602e4: Managed Pi sessions can now fork an existing Pi transcript into the mesh and recover the exact active Pi session after an unexpected process crash. The Pi adapter reports session changes through its authenticated local control endpoint and an owner-only atomic state file; the manager preserves the Cotal identity, lifecycle UID, credentials, children, and durable inbox across up to three restarts in two minutes, then retires a crash loop loudly. Deliberate stops never restart.

## 0.24.0

### Minor Changes

- 5b0642e: SPEC v0.5: workflow runs, and the normative language reference.

  `SPEC.md` gains the v0.5 binding revision: a §14 "Workflow runs" that defines a run's wire footprint
  (the `run` record with its resolved pin set, the `WFJ_<space>` step-journal
  stream with one subject per run and its replay-then-activate barrier, the `answer`, `notice` and
  `migration` record kinds with their derived ids, the per-run driver grants, and a conformance list),
  the four kinds in the §13.7 table, the stream in §13.12, and the change-log, reference-map and
  normative-reference rows. `spec/cotal-lang.md` is the new normative reference for the workflow
  language: syntax table, values and the boundary rule, the library, the effect primitives with their
  hashed projections, the concurrency scopes and the clock-decided race, determinism (time, randomness,
  pins, language version), errors, the step journal's entry schema, key grammar, digest and request id,
  resume, migrate and fork, and the error catalog. Every `js` block in it is validated by the language's
  surface suite. `docs/workflows.md` is the guide, and `cotal_docs` serves the reference offline as page
  `lang` (also `cotal-lang`), indexed for search beside the spec. This is the contract, ahead of the
  hosting: on the mesh handler `spawn`, `turn`, `ask`, `monitor`, `wait(replied)`, `wait(down)` and
  `conclave` still refuse with L5016, and no `cotal` command starts a run yet; a program runs
  in-process through `@cotal-ai/lang` today, as the guide says.

## 0.23.0

### Minor Changes

- 5634356: `cotal attach` re-establishes its session when the link dies, instead of leaving you with a dead terminal.

  An attach left alone while the laptop slept was gone by the time you came back, in one of two ways
  depending on how long the link was down. Shorter than the serving side's stall watchdog: the
  manager's rail keeps advancing its sequence into a subject nobody is subscribed to, and the session
  transport has no retention, so those frames are gone. The moment the client redials and its
  subscription is restored, the next frame lands far ahead of what the client expected, the rail
  faults, and the CLI exits with `mesh session transport error: gap` about a second after the network
  came back. Longer than the stall: the serving rail fills its window, stalls, ends the session and
  closes, and both of those notices are published while the client is disconnected, so neither is ever
  delivered. On redial the client is subscribed to a session nobody is serving and hangs there with no
  output, no honest end and no exit at all.

  `attach` now owns re-establishment rather than leaving it to the NATS layer. When the link breaks and
  you did not press the detach key, it prints `[cotal: connection lost, reconnecting]` on stderr, then
  asks the manager for a fresh grant, mints a fresh per-session credential, opens a fresh connection
  and a fresh session, prints `[cotal: reconnected]`, and carries on in the same raw-mode terminal.
  The manager repaints the seat's current screen through the path it already uses for any attach.
  Retries wait 1s, 2s, 5s, 10s, then 30s, for as long as the seat exists, and the detach key is read
  during the waits between attempts, so a reconnect never traps you. Every attempt re-runs the manager's full authorization, so a
  reconnect cannot keep a revoked or expired grant alive: no grant is ever presented twice.

  Giving up always says why. A manager that refuses the attach exits non-zero with the manager's own
  message; a reconnect that finds the seat no longer there exits cleanly with `seat <name> is gone`. A
  refusal that could still pass, such as a manager at its session ceiling, is relayed in the manager's
  own words while the loop keeps trying, so waiting is never unexplained. Pressing the detach key, or
  the agent's process exiting while you are attached, ends the attach as before.

  Each reconnect also hands the abandoned session back to the manager, over the first link that can
  carry the message, so an attach that rides out several outages does not consume a session slot per
  outage. Nothing on the serving side reaps a session whose caller went away while the seat is quiet:
  the stall watchdog only arms once the send window fills, and an idle seat never fills it. The client
  is the only party that knows, so it says so, using the session's own credential, the only one
  scoped to that session's subjects. If it never gets a link that can carry the message, it says that
  instead, on exit. Every wait on a link that is dying is bounded, and the bound is real: the timer
  that enforces it is what keeps the process alive while a socket that will never answer is waited
  on. A link that stays UP and carries nothing, which is what a sleeping laptop looks like from the
  client, ends with the same clean exit and the same message as any other fault instead of the
  command aborting on a wait that never returned.

  `--no-reconnect` restores the single-session behaviour for scripts that want one run and one exit
  code.

  Under it, `@cotal-ai/workspace` separates a connect refusal from what is done about one. Resolving a
  mesh and its preflight answered every refusal by printing a sentence and ending the process, which is
  right for a person who just typed a command and wrong for a loop riding out a broker that is briefly
  unreachable. The decision now raises a `ConnectRefusal` carrying that exact sentence, and the
  `*OrExit` entry points are thin wrappers that print it and exit as before, so one place writes each
  message and the two forms cannot drift.

- 5e3951a: events: an agent's second session publishes again, and the halt names the causes that can actually produce it

  Only an agent's first session ever published AG-UI events. Every session after it halted the emitter
  permanently. The write-ahead log is keyed per session and the event channel is keyed per principal,
  so a new session opened with an expectation that its channel was empty, while its own previous
  session had already filled it. The broker refused the publish and the emitter stopped for good. On a
  mesh with user authentication the agent name is the actor, and a restart forks the session id, so
  the first restart of any agent spawned with the event plane armed was enough to take its event
  stream dark. An agent on a static credential is reached the same way through preserve and resume,
  which relaunches the recorded identity while the session under it is new. Reproduced against a real
  broker across three sessions, and it did not recover on its own.

  Alongside the per-session logs the connector now keeps one record per principal, holding the last
  sequence the broker assigned on that channel, so a new session continues the stream instead of
  starting again from nothing. An installation upgrading from a release without that record recovers
  the sequence from the session logs already on disk, so the fix applies to agents that have already
  run rather than only to ones starting fresh. That recovery reads the sequence a log took an
  acknowledgement for but did not fold, which is where the real number sits when a session died in
  that window, and it refuses a log it cannot account for rather than taking the largest number it can
  find. An abandonment after a channel purge clears the record with the logs, and a record that reads
  zero is never re-seeded, because that is what abandonment writes.

  The halt message previously offered three causes, another writer, a restored stream, or a filtered
  purge, and the real one was not among them, so an operator went looking for a rogue writer. It now
  names what a moved tip can actually mean, including a concurrent session under the same principal
  and a frontier record that disagrees with the stream. It also names the one cause that is not
  another writer at all: a crash between the shared record's advance and the log's own record of the
  ack leaves the record ahead of the expectation the log is still holding, so the retry publishes a
  sequence the subject has already passed and the halt looks exactly like a foreign write. The
  message says what that state looks like on disk. It also states the real gap in the per-principal
  lock rather than claiming the lock prevents the case the halt fires on: the lock file lives under a
  workspace root, so a second emitter started against a different root meets no lock, while another
  host or a stale pid refuse the start instead of slipping past. And where it used to name an
  abandonment as the remedy, it now says no command performs one, names the directory that has to go,
  and says removing less leaves a mixed state the next start refuses. Clearing that state is valid
  only once the channel itself is back to empty, which of the causes above is true of a filtered
  purge alone; on any other cause the tip stays where it is, so removing the directory returns the
  same halt with the logs a tip could have been rebuilt from now gone, and the channel purge is the
  half that comes first.

  The scan that recovers a tip from the session logs refuses a linked entry and refuses a linked log,
  matching the directory chain that creates this state and already refused a symlinked component.
  Without that, a link planted where a session directory belongs took the scan to a log in another
  tree. What it does not close is a session directory swapped for a link in the moment between the
  check and the open: the non-following open flag covers the final name only, and closing that window
  would take a per-component walk the scan does not do. A log reachable under more than one name is
  refused too, and the ordinary way to produce one is copying a workspace with hard links, which makes
  the recovery refuse every log rather than half-trust them.

  The record itself is now graded on the file rather than on the writer's view of it. A second view of
  one record could take the tip backwards with no error at all, because the comparison was against
  memory while the rule was written about the value on disk. Nothing shipped reaches that today, and
  that is measured rather than assumed: a stale view publishes a stale expectation and the broker
  refuses it before an acknowledgement exists to record. It is guarded anyway, because an assumption
  recorded in prose where a guard belongs is what produced this defect in the first place. A record
  that goes corrupt underneath a live writer is now refused before the write instead of being
  overwritten, and an abandonment refuses outright when it cannot reach the shared record, rather than
  clearing the log's half and reporting a completed abandonment.

  MIGRATION: `AguiEmitter.start` now requires a `subjectFrontier`, and refuses at runtime without one
  rather than falling back to the per-session number, because that fallback is the defect. `EventWal`
  refuses the same way: a log with no record bound has no publish expectation and says so instead of
  offering its own last acknowledged sequence, and an abandonment on an unbound log now refuses rather
  than clearing half of the state, so anyone driving a log outside the emitter must bind one first.
  Anyone embedding the emitter directly must open a `FileSubjectFrontier` at the `subjectPath` that
  `ensureEventWalDir` now returns and pass it. Connectors in this repository are updated. No wire
  bytes move and no grant changes: the channel grammar is unchanged.

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

- dfad94f: Fix two refusals that told an operator to run a grant which silently widened the row

  `cotal actor grant` is an upsert of the WHOLE row. Every flag the operator does not name is filled
  from the wide default: `>` read, `>` post, `spawn,role:default` scope. Two refusals printed a
  re-grant that named `--scope` and nothing else, so following either one reset the row's channel ACLs
  to everything.

  The elevated-view refusal is the sharper of the two. Asked for a view the grant lacks, it printed
  `cotal actor grant <actor> --owner <owner> --scope <current+needed>` and called that "the upsert
  replaces the scope list". An operator adding one view to a deliberately narrow row reset that row's
  read and post sets to `>` and `>` in the same paste, and the same sentence sent them to
  `cotal actor list` to confirm, where the widened row reads as confirmation that it worked. The row
  is a human operator's, and the ACL is minted fresh at every connect, so it takes effect on the next
  one with no restart.

  The missing-spawner refusal has the longer reach. Repairing a broken delegation chain, it printed
  `cotal actor grant <actor> --owner <owner> --scope spawn` and stopped, authoring a spawner that
  reads and posts on every channel. A spawner's own ACL is the ceiling every agent beneath it is
  attenuated against, so one pasted repair set a whole-plane ceiling for everything spawned under it
  from then on.

  The two doors now differ, on purpose. The elevated-view refusal has the row in hand, so it prints
  every field it is replacing, values included. The two delegation refusals have no row to copy from,
  so they print NO runnable command at all and name the flags and the wide default in prose instead:
  a line carrying channel values would invent them, and a line short of all three flags widens on
  paste. Both say what leaving a flag off means. `docs/cli.md` no
  longer tells a reader that a re-grant adds to the current scope, the `cotal actor grant` usage line
  now states what an omitted flag defaults to, and the two remaining hints that name a bare grant say
  that it is the full envelope, matching the wording `cotal login` already used.

  Both refusals are gated by cells that parse the service's own refusal string rather than matching a
  hardcoded command, so the text and the assertion cannot drift apart, and a mutation per site reverts
  each refusal to its shipped text and reddens that cell.

  The strings are not new. Every release from v0.11.0 to v0.21.0 carries all three, which is the whole
  life of the per-user actor ledger. Nothing about the on-disk row changes here, so no migration is
  needed, but an operator who followed either refusal should check the affected rows with
  `cotal actor list`: a widened row cannot be told from a deliberately full one, since the row records
  only when it was granted, not what it held before.

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

## 0.20.1

## 0.20.0

## 0.19.0

### Minor Changes

- ae2f31b: Add the event channel, the durable substrate, and the emitter that publishes a frame.

  The per-agent event channel is `events.<owner>.<actor>`, keyed on the principal. A display name is
  not an identity: names may legally repeat, and they permit spaces, dots and mixed case, so a
  name-keyed channel fuses distinct principals onto one subject and a grant minted from that value
  authorizes both of them onto it. Keyed on the principal the mapping is injective by construction
  rather than by digest length. Resolving a channel from a display name refuses an ambiguous name
  instead of picking a match, because returning the first one shows one agent's stream under another's
  name with nothing on the wire looking wrong.

  The write-ahead log is one file and one state machine. It freezes the retry id, the expected subject
  tip, the bracket state and the source cursor before a publish, so a restart re-publishes the same
  frame rather than a new one, and a frame is either on the wire and folded into the frontier or on
  neither. It refuses the states its own writer cannot produce, since those are the states corruption
  produces.

  The durable source returns a cursor per record rather than per read, so a crash between two records
  of one batch resumes after the last record actually consumed.

  The emitter reads that source forward from the WAL's cursor, packs records into frames that provably
  fit, and appends them under an optimistic-concurrency expectation with a frozen dedup id. At startup
  it reads the chat stream's replica count and refuses to run where the ordering its retry rule depends
  on does not hold. A duplicate acknowledgement arriving on a retry is a halt, not a success: accepting
  it would advance the frontier over a frame nobody received, and neither the wire nor the consumer's
  sequence would show a gap.

  Frame sizing is measured by the endpoint that builds the envelope and sets the headers, never
  recomputed here. A splitter that sized a frame itself would be measuring the frame while the broker
  measures the message, and the part it produced would be rejected, which turns a labelled truncation
  back into a silent loss.

  One emitter writes one principal's log, and that is enforced rather than described. The lock beside
  the log is acquired and held for the life of the process, so a second start on the same principal is
  refused by name; a lock whose recorded owner is provably gone is reclaimed, so one crash does not
  leave a principal unstartable, and a record naming another host or naming nobody checkable is
  refused rather than reclaimed on a guess. A lock cannot see a handle that predates it, so every
  durable replace also carries a generation the writer bumps and verifies: a handle holding an older
  view of the document is refused instead of overwriting a newer one. Without both, two logs opened on
  one file let the loser rewrite a folded frontier to a subject sequence the broker never assigned,
  which reads back as a healthy log and wedges every later publish. The document version moves to 3
  for that generation; older documents migrate forward, and there is no downgrade.

  Nothing in production emits yet: no connector constructs an emitter, and the transcript mirror is
  untouched.

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

### Patch Changes

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

- 82dd701: Forward `NEBIUS_API_KEY` to spawned agents: Nebius Token Factory joins the model-provider
  allow-list, so OpenCode's native `nebius` provider (and the Hermes registry) can authenticate
  from a managed spawn. Adds the Token Factory operator guide (`docs/nebius-token-factory.md`).
- 12f2df8: Refuse to stamp the connector seed store down to an older generation. A cotal older than the store's
  stamped generation used to miss the fast path, refresh nothing, and then write its own version over
  the stamp, leaving the store claiming a generation whose payloads were not the ones installed and
  making the next newer command reinstall every connector. It now fails loud before writing anything,
  naming both generations and pointing at `cotal ext seed --reset`.

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

## 0.17.0

### Minor Changes

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

- 019afc3: The manager control surface gains three capabilities on the v0.4 endpoint rails: spawn as an action, multi-manager instance addressing, and attach as a mesh session.

  Spawn and launch are now actions (SPEC 13.6). Asking the manager for an agent no longer blocks the caller while the process comes up: the manager accepts a spawn goal and returns the allocated identity at once (`{name, owner, actor, uid, goalId, fingerprint, executor{lifecycleUid, epoch}}`), then progress events follow the launch to a terminal outcome. Presence within the readiness window settles the goal `succeeded`, an early exit `failed`, and the window elapsing with neither is `uncertain` (a bounded, durable outcome a later `ps` settles against the live roster, never a silent hang). A persona-derived name collision auto-numbers; a hard-pinned `--name` colliding with a live agent refuses at accept, before anything is minted. The `--detach` CLI spawn, the manifest `-f` launch, and the connector's `cotal_spawn` submit and follow to the terminal, so their behavior is unchanged. The goal terminal is fenced to the executing manager's own gate epoch (the terminal lands on an epoch-scoped result subject), so a superseded incarnation's terminal is invisible to current readers; a durable reconcile index lets a restarted manager settle any goal a predecessor accepted but never terminalized. The goal-fact writer is a dedicated, family-staged, renewed credential disjoint from the serve credential.

  One space can now run more than one manager. Each manager persists a stable logical instance id across restarts and advances its process epoch when it comes back, so peers address a specific manager regardless of which process currently serves it; a restart re-registers the same instance and evicts its predecessor's serve family through a scoped, one-registration eviction credential. `cotal spawn --on <instance>` pins one instance by its exact id, an untargeted spawn rides class anycast (the acceptance records which instance took it), and `cotal ps` / `status` become a class scatter that merges every registered instance's rows with per-instance attribution and labels a non-answering instance unreachable, never omitting it. The manager lease is demoted from a per-space singleton to per-instance liveness (loss stops only that instance's serving, never the space), reconcile touches only rows the instance owns, and the retirement rail authorizes on the registration gate rather than a name-derived holder, so a deposed predecessor cannot retire a target.

  `cotal attach` no longer returns a `127.0.0.1` websocket URL. It creates a one-use, holder-bound session over the mesh: the reply carries a signed session grant (no URL, never logged), redeemed once, after which terminal bytes stream on session subjects scoped to the two parties, with backpressure surfaced as an explicit drop notice. A late attach still repaints the full screen from a replayed terminal snapshot, and close, expiry, target despawn, and manager restart are distinct, surfaced end states. The browser console is now a real mesh session client over a served bundle (the broker gains a localhost-default websocket listener), holding only a per-session, rails-only credential that expires with the session. The manager's session writer is a scoped, family-staged, renewed credential over a dedicated sessions store.

- f85ffbf: The manager now registers itself as an ordinary v0.4 `service` endpoint (`manager`) on every static auth mesh and dual-serves its FULL typed command surface on the endpoint rails beside the existing control tiers — nothing removed yet. The served commands mirror every control op through the same handler cores: `status`, `ps`, `inspect` (per-agent read), `models`, `spawn` (the full 16-field launch surface), targeted owner-mode `despawn`/`attach`, the baseline self-mode `stop`, `define-persona`, `purge`, `launch`, the resume/preservation family, and the reserved `describe`. `ps`/`inspect`/`spawn` replies now also carry each agent's `lifecycleUid` (the coordinate a targeted request pins). Core gains the production endpoint-serve credential subsystem over the durable auth store: the §13.1 endpoint issuance gate and serve ledger (`epgate…`/`epcred…`), the registration barrier with fail-closed eviction, and the serve-mint release fence — plus a key-pinned one-shot `endpoint-serve-executor` credential profile scoped to exactly one endpoint instance's gate, serve-ledger family, and registration record keys. The manager drives its registration and every serve-credential mint and renewal through that scoped executor connection (never its standing supervisor connection), applies one shared lifecycle-membership + maintenance admission gate on both control doors (the legacy `ctl` tiers and the new endpoint rails), and renews its bounded serve credential on the standing renewal pass. Registration also publishes the manager's §13.7 contract artifacts — every command's schema root, its closure manifest, and the cluster document — to the per-space content-addressed contract store (created create-or-verify at manager start alongside the authority stores), and every agent credential's baseline now carries the store's read grant, so any caller can fetch, verify, and recompile the registered schema digests without out-of-band contract sharing.

  The control CONSUMERS now ride those rails (static-auth meshes): every CLI manager call (`spawn --detach`, `ps`, `stop`, `attach`, `models`, `down`/`up`'s resume and preservation phases) and every connector supervision tool (`cotal_spawn`/`cotal_despawn`/`cotal_persona`, self-stop, history purge) goes through the generic invoke path - describe, fetch the registered schemas from the contract store, recompile digest-verified validators, invoke - instead of hand-importing the manager's contracts; invoke currency is describe-bound (the answering incarnation's broker-authenticated identity), so a superseded or split-brain manager refuses instead of answering stale. New `cotal describe <endpoint>` and `cotal invoke <endpoint> <command>` expose the same generic surface to operators. Operator reach is now minted, not door-refined: `control-caller-privileged`/`control-caller-admin`/`deployer` instrument credentials carry tier-matched endpoint capability rows (the admin tier's cross-agent `despawn`/`attach` ride the operator-only `any` authorization mode, declared in the manager's revision-3 cluster document), the spawn capability additionally mints `define-persona` + `inspect`, and an `admin`-capability credential mirrors the full admin instrument set. Open meshes and user-mode bearers kept the legacy `ctl` path until the final slice below.

  User-mode meshes join the migration end to end: the manager registers its v0.4 service on per-user meshes too (the registration/serve machinery is operator infrastructure riding the space's static trust material), the CLI's bearer path derives its caller triple from the bearer's ledger lifecycle claim, the connector's endpoint identity is its triple in every auth mode (no ctl branch left in the connector), and `spawn -f`'s deploy probe drives `ps`/`launch` over the generic invoke path for both the static admin credential and the user-mode deployer view. Serve-side hardening: every `manager.admin`-class command (purge, launch, and the resume/preservation family) re-checks operator reach at serve time against the caller's CURRENT ledger scope on user meshes, so a revoked `admin` scope demotes the next call instead of riding out the bearer's remaining row lifetime.

  The migration is now complete: the manager's legacy `ctl` control rail is deleted. Core drops the `manager`/`self`/`admin` control tiers, the `ControlTier` type, and `controlSubject`; the server-side `ctl.delivery`/`ctl.delivery-admin`/`ctl.auth-admin` rails (the delivery daemon's and auth service's own carve-outs) are unchanged. Every credential profile is endpoint-only: agent baselines lose the `ctl.self` publish and control-reply subscribe rows, the supervisor serves no control tier, and the operator instruments carry endpoint capability rows only, so the old manager control subjects are unreachable end to end (publish rows, serve subscriptions, and handlers are all gone). The manager registers its `service` endpoint on EVERY mesh: auth meshes ride the scoped endpoint-serve executor; open meshes run the same gate/registration/serve-grant ceremony over bare one-shot connections (no credential is ever minted; the broker enforces nothing on an open mesh) and create-or-verify the authority stores at boot, so a raw broker no longer dies at the first gate write. The CLI's control layer replaces `ControlTier` with `ControlReach` (`owner`/`any`): the target's authorization mode derives from the resolved target owner (an own-domain target rides owner mode; a cross-owner target rides any mode, which the broker admits only for admin-instrument holders), open meshes ride a bare caller triple, and a raw `--creds` control caller without an endpoint caller identity refuses loud instead of falling back. `ps`/`inspect` rows pin `role` as optional (a manifest-launched agent declares none, and the reply schema previously failed the responder's own output).

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

- a306df0: Never consume a Claude Code peer's message without delivering it.

  An unattended agent could go permanently silent after a direct message. The connector's lifecycle
  hook acked the message and marked it handled while it was still only _formatting_ the hook reply
  that carries it, but that reply has to reach the runtime through the hook relay, which abandons the
  exchange after two seconds. When it did not land, the agent's model never saw the message while the
  connector had already committed it — and because the message was recorded as handled, its own
  JetStream redelivery was acked and discarded on arrival, so nothing could bring it back. The peer
  simply stopped answering, and only a human noticed.

  A message is now committed only once the reply carrying it has cleared both legs of its journey, not
  just the first. The hook relay confirms back to the connector only after its own write to the
  runtime has completed cleanly, and the connector waits for that receipt
  (`startControlServer` gains an additive `onReply(event, delivered)`, and a client opts in with
  `handoff: true`); anything less leaves the message un-acked, so it redelivers and the agent is woken
  again. Binding to the connector's own socket write was not enough: a large injection that the
  relay's one-second flush backstop kills mid-write reaches nothing, and the batch was still
  committed. The verdict is tracked per hook event rather than in one slot, because hook frames are
  separate connections that can overlap and would otherwise let one frame's outcome commit another
  frame's messages. This errs toward delivering twice rather than losing one: a re-surfaced batch is
  flagged as a possible repeat.

  Two further ways the same path could go quiet are closed. Presence updates no longer gate delivery —
  a failed presence write used to skip both the message injection and the end-of-turn flush of
  anything held while the agent was busy. And a rejected wake notification is now retried with a
  bounded backoff, since for an idle agent it is the only thing that can wake it.

- a26e5f2: Always answer an authenticated control-plane client, whether or not anyone observes delivery.

  The reply write sat inside an optional call's argument list:

  ```ts
  opts.onReply?.(ev, await writeReply(sock, reply, awaitHandoff));
  ```

  Optional chaining short-circuits the entire call expression when the callback is absent, arguments
  included, so `writeReply` was never evaluated for any caller that does not pass `onReply`. The
  handler still ran and still saw the event; only the client saw the silence, then timed out. Of the
  five callers of `startControlServer`, only the Claude Code adapter passes `onReply`, so the opencode
  and hermes hook relays got no reply to any control frame, and the pi and codex adapters lost the
  error reply they answer non-shutdown ops with. Cooperative shutdown was unaffected: it is acked on a
  separate synchronous path.

  Writing the reply is the server's job; `onReply` only watches it. The write is now performed first
  and its verdict passed to the callback, so the two are no longer coupled.

  Covered by a new broker-free suite, `smoke:control-reply`, which drives each of the four production
  opts shapes and asserts the reply arrives. Mutation-proved by restoring the short-circuit, which
  reddens the no-callback cases while the "handler ran" cell still passes, which is precisely the
  asymmetry that made this invisible from the server side.

  The one suite that did catch it, `smoke:windows`, is Windows-only, and its red had been merged past
  repeatedly. The new suite runs on POSIX and is in `smoke:ci`.

## 0.16.0

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

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

### Patch Changes

- fce3199: Report which machine an agent runs on, and fix three defects that only appear once a mesh spans hosts.

  **`meta.host` on the agent card.** A mesh can span machines: a manager on another box launches
  agents into its own host, so "where is this agent actually running" was unanswerable from the
  roster. Each session now publishes its own `os.hostname()` as `meta.host`, overlaid last like
  `meta.connector` so an agent file cannot claim a host it is not on. It is advisory display
  metadata only, never an authorization or routing input, and the dashboard renders it with no
  change (unknown meta keys already display generically). `SPEC.md` records it alongside the other
  reserved `meta` keys.

  **`cotal up --host <addr>` killed the broker it had just started.** The bind address and the
  broker URL were tracked independently, so `--host` bound one address while the readiness probe
  still used the loopback default. The probe found nothing, timed out, and the caller SIGTERM'd a
  broker that had started correctly, which made `--host` alone impossible to use. The two are now
  reconciled: with no explicit `--server`, the URL is derived from the host; a contradicting pair is
  refused with one sentence instead of starting something unreachable; and wildcard binds
  (`0.0.0.0`, `::`) correctly keep a dialable loopback URL rather than advertising the wildcard. The
  manifest path (`broker.host` without `broker.servers`) had the same defect and shares the fix.

  **One slow probe silently unregistered a live mesh.** `pruneStaleMeshes` deleted any registry
  entry that failed a single reachability check whose budget is 1s, which a healthy broker across a
  slow or jittery link misses routinely. Deletion is destructive and, for a mesh this machine did
  not start, unrecoverable, since only `cotal up` writes registry records. A first failure now only
  makes an entry a candidate; it is pruned only if a second, longer probe also fails. A genuinely
  dead mesh still prunes.

  **A timed-out request killed the whole dashboard.** `cotal web` passed an async listener to
  `createServer`, so a rejection inside any route (for example a JetStream call timing out against a
  slow broker) became an unhandled rejection and took the process down on the first slow request.
  The dashboard is a read-only observer: a failing route now returns 500 and the server stays up.

## 0.14.2

## 0.14.1

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

- 8aee34e: Distribute Cotal's authored Agent Skills (`SKILL.md`), starting with `team-topology`, from one canonical source in the CLI package to every AI coding harness, with real central update and removal.

  - **Claude Code:** a skills-only `cotal-skills` plugin in the existing `cotal-mesh` marketplace, installed at user scope and independent of the mesh connector (it carries no code and no core dependency). Its plugin version is stamped from the running CLI release and `cotal setup` runs `claude plugin update`, so an upgrade actually replaces the cached skill; each plugin dir is rebuilt from an allowlist and swapped in, never merged, so no stale file rides in. It installs on first run and, fail-loud, on repeat runs, so upgraders are not left behind, and the install is verified via `claude plugin list --json` (exact id, scope/project, enabled, no errors, and expected version). `cotal status` gains a "Claude skills" row.
  - **Every other harness** (Codex, Cursor, OpenCode, Gemini CLI, Windsurf/Devin): `cotal setup` reconciles the cross-vendor `~/.agents/skills/` directory at the file level, tracked by a validated manifest under `~/.cotal`. Cotal owns exactly each skill's `SKILL.md`: before overwriting a copy you have edited it copies your version into a fresh `SKILL.md.bak` slot (never overwriting an existing or third-party backup), and on removal deletes only that file (then the dir if it is left empty), never a whole directory, never a user's other files, and never a third-party skill. Every managed write (skill file and ownership manifest) goes through a stage-and-rename with an exclusively-created temp (so a hard-linked or symlinked path is replaced, never written through to an outside inode), and a malformed or corrupt manifest fails loud. `cotal status` reports current/stale/missing/retired for the drop and current/stale/missing/broken for the Claude plugin.
  - The website Agent Skills discovery index is generated from the same canonical files and reconciled (a removed skill stops being served/indexed); a forward bet on the draft RFC, which no shipping harness consumes yet.

  A corrupt or empty skills bundle fails loud rather than silently shipping zero skills.

## 0.13.2

### Patch Changes

- 9e3fdd6: cli: make installed extensions discoverable. Bare `cotal ext` now lists the inventory instead of erroring; `cotal ext list` and the `cotal status` Extensions section lead with the install prefix and state it is a cotal-owned store kept separate from npm's global tree (which is why `npm list -g` never shows these); a new `cotal ext root` prints just the path for scripts, and `status` always renders the section with an explicit empty state. Discoverability only: where extensions install and how they upgrade is unchanged.
- 666a1a1: docs: a new Connectors page compares every connector feature-by-feature (binding, install, TUI, delivery, resume, tool-sharing, models, containers), and the pi guide moves from Agent frameworks to Connect pi so it sits beside the other connector guides (the site redirects `/agent-frameworks` to `/connect-pi`). The bundled `cotal_docs` pages are regenerated to match.
- 9625ec6: Add `cotal update` to reconcile first-party connectors and extensions to one generation, report third-party extensions, and check or opt into a serialized, verified global CLI upgrade.

## 0.13.1

### Patch Changes

- 5fb7b23: Add `cotal -v` / `cotal --version`: print the binary version plus each installed extension's, then exit. `cotal status` gains the same report — the Machine section leads with the `cotal-ai` version, and a new Extensions section lists each installed extension with its pinned version, so version skew across the seeded connectors is visible at a glance.

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

### Patch Changes

- 046f485: Re-announce an unacked durable message on JetStream redelivery, so a wake the host dropped (e.g. during Claude's channel startup window) recovers at the next redelivery instead of leaving the agent a zombie until an unrelated message arrives.

## 0.11.6

## 0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- 5634ae4: Keep quiet-channel ambient traffic pull-only across every connector.

## 0.11.3

## 0.11.2

## 0.11.1

### Patch Changes

- 5b2863a: feat: `cotal clean` - one configurable cleanup verb (history / store / all)

  `cotal down` deliberately preserves the on-disk JetStream store, so stale broker state (e.g.
  durables minted by an older, incompatible Cotal generation) survived every down/up cycle and made
  a new-generation `cotal spawn` fail with `consumer already exists`. `cotal clean <history|store|all>
--force` is the operator reset:

  - **history**: purge the retained message backlog on the running broker (channels, plus DMs with
    `--dms`) over the least-privilege purger cred; `cotal history clear` stays as a thin alias.
  - **store**: delete the stopped mesh's JetStream store (`.cotal/nats` or `--store-dir`).
  - **all**: store + the space identity (`.cotal/auth`), every locally persisted cred/marker tied to
    it, crash residue a normal `down` would have swept, and this root's registry entries; the next
    `up` mints a fresh identity.

  Hardening that shipped with it: one shared pidfile probe for `down`/`clean`/`status` (pid > 0
  only; EPERM reads as alive), `down` no longer erases the record of a process it cannot stop nor
  presents a failed stop as clean, registry teardown keys on the canonicalized project root
  everywhere (a named open mesh can no longer delete another mesh's entry), and stale-store failures
  plus `cotal status` now name the reset recipe.

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

- 878f406: Persona ownership, env allow-list, MCP sharing, and the reconnect tool

  - **`definePersona` content/policy split** with a write-once persistent file owner: a peer can't
    grant itself a capability or seize ownership of a persona file, and a persona-only edit can't
    silently clear an existing model. `role` is spawn-time policy and has been removed from the
    `cotal_persona` tool surface (advertising it was a silent no-op).
  - **Spawned-child env allow-list** (`launch.ts`): runtimes receive only the declared env, never
    `process.env`, with per-connector model-key forwarding.
  - **Opt-in per-connector MCP server sharing** for spawned agents.
  - **`cotal_reconnect`** tool added to the shared tool surface (renders on both Claude Code and
    OpenCode) for manual mesh recovery. `cotal_purge` is dropped from the agent tool surface — it
    is admin-only now, so the operator path is `cotal history clear`.
  - Agent transcript mirroring is now opt-in (default off); a spawn permission denial names the
    missing capability instead of blaming the manager.

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

## 0.2.0

### Minor Changes

- 73b030f: Add the `cotal_feedback` sender: a connector tool (always exposed) and a `cotal feedback "<summary>"` CLI mode. With a `COTAL_FEEDBACK_KEY` feedback routes to the keyed broker intake as before; without one it goes to the public intake at `https://cotal.ai/v1/feedback`, which requires a contact email (`COTAL_FEEDBACK_EMAIL` → git config → ask). `COTAL_FEEDBACK_URL` overrides either URL for self-hosted intakes.
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

## 0.1.3

### Patch Changes

- 246c9b9: Add the `cotal_feedback` beta egress: a `COTAL_FEEDBACK_KEY` config plus `feedbackLine()` guidance folded into the Claude/Codex connector instructions, and a `cotal feedback` authenticated intake server (tester keys, JSONL source of truth, republish to an internal `#feedback` channel). Note: the agent-side `cotal_feedback` tool registration is still pending.
- 246c9b9: Add the OpenCode connector. It launches a watchable `opencode` TUI bound to the agent's session — a headless `opencode serve` with the mesh plugin loaded, plus a foreground `opencode attach --session <id>` — drives that visible session via `session.promptAsync`, and renders the `cotal_*` tools as native plugin tools at Claude-Code parity. The tool surface is extracted into `cotalToolSpecs` in connector-core so the Claude/Codex MCP adapters and the OpenCode plugin render the same tools.

## 0.1.2

### Patch Changes

- 5f9e171: Publish all packages: add repository field for OIDC provenance, plus in-flight changes (cmux runtime exec-via-env fix, manager runtime selector, .gitignore product/, etc.).
- Updated dependencies [5f9e171]
  - @cotal-ai/core@0.1.2

## 0.1.1

### Patch Changes

- 18c271f: Publish all packages: configure GitHub Actions changesets workflow with npm OIDC trusted publishing.
- Updated dependencies [18c271f]
  - @cotal-ai/core@0.1.1
