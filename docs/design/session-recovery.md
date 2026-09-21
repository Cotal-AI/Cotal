# Session recovery for a managed seat

A design record, not a description of shipped behavior. Every claim about current behavior
names the file and the function it was read from. Everything else is proposed.

## The question

A managed seat is a harness process (pi, Claude Code, jcode) that a Cotal manager spawned and owns.
The seat stops on one host and resumes on another host of the same architecture, with its session
history, tools and repository state intact, and with one writer at any time. This record states the
contract a manager and a seat follow so that is safe, and separates the part the current code already
gives us from the part that is new.

The scope is one seat's continuity across hosts. It is not broker migration: a space's streams move
by the offline backup path, and `docs/cli.md` (Backups) records that restore recreates the endpoint
plane streams empty, so a hosted workflow run does not cross a backup at all. Section 4 takes that as
a constraint rather than arguing with it.

### What exists today

The manager already has a crash-safe same-host preservation handshake. `Manager.preparePreservation`
in `implementations/manager/src/manager.ts` fences new lifecycle work, drains accepted work through
`awaitLifecycleDrain`, and builds a `ManagerResumeInventory` from `Manager.resumeEntry` without
stopping a child. `Manager.commitPreservation` then hard-stops each child and proves its exit through
`Manager.awaitHandleExit`, which refuses when a runtime does not implement `AgentHandle.waitForExit`.
On the other side `Manager.resumePreserved` re-adopts each entry, `Manager.opCommitResume` revalidates
it, and `Manager.opFinalizeResume` releases the fence against a token. The inventory is parsed by
`parseResumeControlArgs` in `implementations/manager/src/resume.ts` under a strict schema and a 512
KiB cap. What does not exist is any capture of the working tree, any wall-clock freshness bound, and
any persisted per-seat writer generation. Those three are the substance of this design.

## 1. Recovery point

A checkpoint is the durable description of one seat at one instant, sufficient to start that seat on
another host. It is content-addressed and non-secret by construction.

### 1.1 What it contains

**The manager's resume entry, unchanged.** `ManagerResumeAgent` in `manager.ts` is already the record
of what a seat is: `space`, `name`, `role`, a `ManagerResumeIdentity` discriminated on `mode`
(`open`, `static`, `user`), and a `launch` block carrying `connector`, `runtime`, `cwd`, a `source`
that is either a persona reference or a resolved manifest reference with its `configSha256`, plus
`model`, `variant`, `subscribe`, `allowSubscribe`, `allowPublish`, `capabilities`, `events`,
`shareTools`, `forkSource` and `sessionId`. It also carries `dependencies`, `spawner`,
`authorityParent` and `startedAt`. A checkpoint carries this entry as its own first field and does
not restate any of it.

The identity field is the load-bearing one. `ManagerResumeIdentity` documents in its own comment that
`lifecycleUid` is the agent's original incarnation uid and that a resume must recover it rather than
mint a fresh one, because the durables are keyed by it. `resume.ts` enforces the token shape
(`/^[a-z0-9]{26,32}$/`) on that field for all three modes.

**Repository state, as a bundle plus a delta.** This does not exist today. `ManagerResumeAgent.launch.cwd`
is a path string, and `Manager.inventoryReferenceError` validates only the named dependency files:
each must be a regular non-symlink file, a static credential must be mode 0600, and the launch config
and credential digests must still match what the inventory recorded. Nothing looks at the working
tree, and `git bundle` appears nowhere in this repository. A cross-host resume therefore needs a new
component, and it is proposed here in the form a self-hoster can verify by hand:

- a bundle of the reachable history of the seat's `cwd` at the cut, written by the operator's own git,
  recorded in the checkpoint by path, byte size and sha256;
- the base commit the bundle is anchored on, by full object id, so a destination refuses a bundle that
  does not apply to the tree it holds;
- a delta covering everything the bundle cannot carry: tracked modifications, the index, and the
  untracked files the operator declares in scope. Recorded the same way, by size and digest.

The delta is the part an operator gets wrong, so the checkpoint states its own completeness rather
than implying it. The delta record carries the exact selection rule it was produced under, and a
destination that cannot reproduce that rule refuses. An untracked path that was in scope and is
absent from the delta is a refusal, never a silently thinner tree. This follows the shape
`inventoryReferenceError` already uses for dependency files: a recorded reference that cannot be
proven is an error, not a warning.

**The harness session store at a consistent cut.** Each harness keeps its transcript in its own
files, in its own format, and Cotal does not parse them. The checkpoint carries them as an opaque set
with per-file size and sha256, plus the harness-declared session id the set is expected to reopen.
Section 5 gives the per-harness file set and says where this repository does not name one.

The manager already holds the pointer half of this for a continuation-capable connector.
`LaunchSpec.sessionStatePath` in `packages/core/src/connector.ts` is documented as a connector-owned
host-session state file that contains no transcript and no credential, and
`Manager.readSessionStatePath` parses it under a closed shape: `version` must be 1, `sessionId` must
be a non-empty string under 4096 bytes, and `status` must be `running` or `quit`. That file is a
pointer to a session, not the session. The checkpoint carries both: the pointer, and the store the
pointer names.

**Tool and environment configuration.** What the seat's tools were, in the form the manager can
re-derive them from: the connector name, the `shareTools` selection, and the `capabilities` list,
all of which are already `ManagerResumeAgent.launch` fields. Opaque connector launch options are
deliberately not carried. `ManagerResumeAgent.launch` records only
`unresolvedLaunchOptionKeys`, with the comment that values are not persisted because launch options
are opaque and may be secrets, and `Manager.inventoryReferenceError` refuses an entry that has any:
`imperative launch options have no non-secret durable source`. A checkpoint inherits that refusal.
A seat launched with such options is not checkpointable, and the honest answer at cut time is to say
so rather than to write a checkpoint that will not reproduce the seat.

**The applied profile revision.** The revision of the launch profile the seat is running under, so a
destination can tell whether it is resuming the same intent. Today the manifest path carries
`hash` on `MeshLaunchAgent` in `packages/core/src/launch.ts`, described there as a content hash of
the resolved launch fields for drift detection, and `ManagerResumeAgent.launch.source` carries
`manifestSha256` and `configSha256` for the manifest and persona cases. A checkpoint records whichever
of those applies, and a destination whose current profile revision differs resumes under the recorded
one or refuses. It never silently applies the newer profile to a resumed session: that is a different
seat wearing a recovered transcript.

### 1.2 What it excludes

**Live memory.** No process image, no heap, no open file descriptors, no PTY scrollback. The seat
resumes by reopening a session from its own store, which is why section 5 is a per-harness question
and not a single mechanism. A harness that cannot reopen by id cannot be continued, and section 5
says which ones those are.

**Source-host control credentials.** The manager's own launch material never enters a checkpoint.
This follows the rule the code already keeps: `ManagedAgent.control` in `manager.ts` carries the
per-seat control socket path and first-frame token, and its comment states it is kept in memory only
and never persisted for token hygiene. `Manager.resumeEntry` writes no control field.

**Operator keys.** No nkey seed, no signing key, no bearer token, no `$SYS` material. The manager's
own instance identity is out of scope by the same rule: `ManagerInstanceIdentity` in
`packages/workspace/src/auth-paths.ts` holds a private seed and is documented as landing in a
hardened secret file for that reason.

A checkpoint does carry credential *references*: `ManagerResumeIdentity` in mode `static` carries
`credential: { kind: "file"; path; sha256 }`, and mode `user` carries `actorToken`,
`sentinelCredential` and `health` the same way. A reference is a path and a digest, and the file it
names stays on the host. Moving a seat across hosts therefore requires the destination to already
hold that identity material, or to be on a shared path both hosts see. This design does not move
secrets and does not propose a mechanism for it. A destination that cannot resolve a recorded
credential reference refuses, which is what `Manager.inventoryReferenceError` already does:
`retained reference unavailable`.

### 1.3 How the cut is taken without racing the running harness

The manager's existing two-phase handshake is the frame, and the harness stop is what makes the cut
consistent. The order is fixed:

1. **Fence.** `Manager.preparePreservation` sets `maintenanceState` to `preserving` before its first
   await and advances `preservationGeneration`. Its comment records why: the fence lands before any
   await, so accepted work has already incremented `lifecycleInFlight`. `Manager.beginLifecycle`
   refuses new work while the state is not `active`, which is how a spawn cannot slip into the cut.
2. **Drain.** `Manager.runPreparation` awaits `awaitLifecycleDrain` before it builds anything, so
   in-flight lifecycle operations finish rather than being cut mid-way.
3. **Plan and validate.** The inventory is built from `Manager.resumeEntry` and every entry is run
   through `Manager.inventoryReferenceError`. The plan is then round-tripped through the real resume
   parser: `runPreparation` calls `parseResumeControlArgs({ attemptId, inventory })` with the comment
   that a cut which cannot resume must fail at prepare time and never after listener exposure. No
   child has stopped yet, so a failure here costs nothing.
4. **Persist.** The coordinator fsyncs the plan. `ManagerPreserveOptions.persistInventory` is
   declared as a callback that must verify the coordinator's locked attempt and durably fsync the
   inventory before resolving, and `Manager.preserveState` awaits it between prepare and commit.
   `writeMaintenanceResumeDocument` in `packages/workspace/src/maintenance.ts` is the shipped writer:
   it writes to a private exclusive temp file, renames, and fsyncs the directory, then reads the
   result back through `readMaintenanceResumeDocument` to prove it.
5. **Stop the harness.** `Manager.runPreservation` sets `suppressCleanup` on every agent, then calls
   `handle.stop({ graceful: false })` with the comment that a preservation cut must not run the
   connector's logical leave or cleanup hooks. This is the line that makes the harness store quiet:
   nothing is running to write to it.
6. **Prove it stopped.** `Manager.awaitHandleExit` awaits `handle.waitForExit()` under
   `preserveStopTimeoutMs` and then re-checks `handle.status() === "exited"`, throwing when a runtime
   reports exit completion while status still says running.
7. **Capture.** Only now are the repository bundle, the delta and the harness session store read. A
   capture before step 6 races the harness by construction.
8. **Seal.** The checkpoint's digests are computed over the captured bytes and the checkpoint record
   is written last, in the manner `BackupManifest` in
   `implementations/cli/src/lib/backup-artifact.ts` already uses: `manifest.json` is written last
   with exact sizes and sha256 values, and `createArtifactWriter` refuses a destination that already
   exists and hardens the directory to 0700 before anything lands in it.

Steps 7 and 8 are additions. Steps 1 through 6 are the shipped sequence, and the design does not
reorder them.

One property of step 5 is worth stating because it is easy to lose. Suppressing the leave hooks is
what keeps the broker footprint intact across a same-host cut: the lifecycle-keyed durables stay, and
`CotalEndpoint.ensureDmDurable` in `packages/core/src/endpoint.ts` documents that an existing
durable for this lifecycle is kept as-is, preserving the original frontier, so the activation moment
never moves. A cut that ran the ordinary teardown would deprovision those durables and the resumed
seat would lose everything queued for it. This is also why the uid must be recovered and not minted.

A cross-host move does not preserve that frontier, and the distinction is load-bearing enough to
state here rather than leave to section 4. A durable consumer is not a file that can be copied. When
the seat's state travels by the offline backup path, the durable is rebuilt from a conservative
checkpoint: `validatePersistentConsumerInventory` in `packages/core/src/backup.ts` records each
recognized pull durable as its contiguous `ack_floor.stream_seq` plus a creation lower bound, and
`consumerConfigFromCheckpoint` rebuilds it at
`max(ackFloorStreamSequence + 1, creationLowerBound, first_seq)`. `expectedConsumerConfig` in that
file is what admits the per-seat durables to this path at all, resolving a `dm_` or `dlv_` name back
through `principalFromDurable` to its owner, actor and lifecycle uid.

The consequence is that the rebuilt consumer starts at or below where the old one stood, never above
it. A message acknowledged out of order, above the contiguous floor, is delivered again. So a
cross-host resume is at-least-once for inbound delivery by construction rather than by accident, and
section 4.2's ledger requirement is what absorbs it. Nothing is lost, and some things arrive twice.

## 2. Freshness admission

A destination must decide whether a checkpoint is recent enough to resume. Today there is no such
decision anywhere in the code: admission is content-addressed and identity-bound, never time-bound.
This section adds the time bound and states plainly which half is new.

### 2.1 What the code checks today

`Manager.resumePreserved` in `manager.ts` performs, in order: an inventory version check against
`cotal-manager-resume/v1`; a space match against its own space; a capacity check against `MAX_AGENTS`
(50, declared in `resume.ts`); a duplicate-name check; a duplicate-principal check; a manager-local
retirement-hold check against `this.retiring`, which refuses and re-drives that exact teardown; and a
roster liveness check that refuses with `retained principal is already live and this runtime cannot
authoritatively adopt it`.

That liveness check has a documented exception, and the design must carry it rather than simplify it.
`resumePreserved` consults `this.confirmedRetiredPredecessors` and does not treat a roster row as
live when that row is the confirmed-retired predecessor of this alias. A stopped predecessor can stay
roster-live until its offline update lands, so a confirmed terminal is not allowed to look like a
live conflict.

Then `Manager.validateRetainedAuthority` re-reads every identity input. It calls
`inventoryReferenceError` again, and its own comment records the own-channel rule: a resume document
is admin-supplied JSON carrying the ACLs the managed row is re-armed from, so a foreign event channel
written into an inventory would become a minted read on another agent's tool inputs one renewal
later. Nothing in any of this reads a clock.

`Manager.opCommitResume` and `Manager.commitResumeActivation` are a validation barrier over the same
facts. `docs/cli.md` (Backups) states it in those terms: `commitResume` is an idempotent validation barrier
only, success must be `awaitingFinalize` with an attempt-bound 64-hex commit token, and it does not
release suppression. It revalidates identity, not recency.

### 2.2 The bound this design adds

Three admission gates, checked in this order, cheapest and most conclusive first.

**Gate 1, integrity.** Every file the checkpoint names must be present, be a regular non-symlink
file, match its recorded byte size, and match its recorded sha256. This is the rule
`inventoryReferenceError` already applies to dependency files and `readMaintenanceResumeDocument`
already applies to the resume document, where it additionally re-stats the file after reading and
refuses when `dev`, `ino`, `size`, `mtimeNs` or `ctimeNs` moved, with the message that the document
changed while it was being read. A checkpoint reader holds itself to that same standard. Failure here
is a refusal, and no other gate is consulted.

**Gate 2, identity.** The recorded `lifecycleUid` must not belong to a live incarnation, judged by
the same two sources `resumePreserved` uses: the manager-local retirement hold, and the roster with
the confirmed-predecessor exception. The recorded space must match. The recorded profile revision
must match the destination's, or the destination must be resuming under the recorded revision
deliberately. Failure here is a refusal.

**Gate 3, recency.** The checkpoint carries `capturedAt` as an absolute instant and the destination
compares it to its own clock against a declared horizon. This is new. The horizon is a property of
the deployment, not of the seat, and it must be stated in the checkpoint so that a destination and an
operator cannot disagree about what was promised.

Recency is a judgment about the world, not about the bytes, so the gate is declarative and its
refusal is explicit:

- **Inside the horizon.** Admitted. The seat resumes.
- **Outside the horizon.** Refused by default, with the recorded `capturedAt`, the destination's
  clock reading and the horizon in the message. An operator may override with an explicit flag,
  because a stale checkpoint is sometimes the only checkpoint. The override is recorded in the
  destination's journal, in the way `up --restore` already requires `--accept-missing-source` as
  explicit disaster consent for a missing canonical source (`docs/cli.md`, up).
- **Unreadable `capturedAt`, or a destination clock the destination does not trust.** Refused, with
  no override. A freshness gate that fails open is not a gate. This follows the repository's
  no-fallbacks convention and the shape `makeManagerEndpointEvictionEvidence` in
  `implementations/manager/src/endpoint-evict.ts` uses, where an unreachable liveness oracle throws
  naming the cure rather than skipping the check.

### 2.3 The limit of what freshness decides

A fresh checkpoint is not a safe checkpoint and this design does not let the horizon pretend
otherwise. Two writers are prevented by section 3's fence, not by recency: a checkpoint captured one
second ago from a host whose seat is still running is as dangerous as one captured a week ago
from the same host. The horizon answers a different question, whether the transcript and the tree are
close enough to the world for the resumed seat's next turn to be sensible.

So the ordering in 2.2 matters. Gate 2 is about authority and gate 3 is about usefulness, and gate 3
having an override is only tolerable because gate 2 does not.

A note on resolution, because it bounds gate 2 rather than gate 3. The roster half of the liveness
read is coarse: `PRESENCE_TTL_MS` in `packages/core/src/streams.ts` is 6000, and the endpoint's
default heartbeat in `CotalEndpoint` is 2000 ms. So presence lags reality by seconds, and
`resumePreserved`'s own refusal text says it cannot authoritatively adopt a live principal rather
than claiming the principal is dead. Presence is a hint that avoids an obvious collision. The fence
is what makes the collision harmless.

## 3. Single-writer fence

One host may write as a given seat, and no more. This section states what the code has today, where the
missing piece goes, and why the broker is the only acceptable enforcement point.

### 3.1 Lifecycle identity as it exists

The broker-side identity is the lifecycle uid, and it is already enforced.

`EndpointOptions.lifecycleUid` in `packages/core/src/endpoint.ts` is documented as this incarnation's
lifecycle UID, minted once per lifecycle by the provisioning authority, and the key of the
lifecycle-keyed messaging durables named there as `dm_…-<uid>`, `dlv_…-<uid>` and `chathist_…-<uid>`.
`CotalEndpoint.requireLifecycleUid` throws when it is absent for any lifecycle-keyed resource.

Enforcement is fail-before-presence, in `CotalEndpoint.start`. An authed endpoint that will register
presence or bind consumers must hold its uid before anything makes it visible. Consumers bind before
presence publishes, and the comment states why: the durable bind is the broker's proof that this
incarnation's lifecycle-keyed names match its minted grants, so a wrong-uid launch dies with no
presence ghost. For an authed agent that registers without consuming there is a second proof: `start`
calls `jsm.consumers.info(dmStream(this.space), dmDurable(this.owner, this.actor, uid))` and throws
`lifecycle proof failed … refusing to publish presence` when that durable is not at the broker. A
wrong uid names a durable that does not exist.

This is the property the fence rests on. A stale host cannot fabricate authority for a uid it was not
provisioned for, because the names are derived from the uid and the grants are minted against those
names. The check is at the broker, not in a cooperating client.

`ManagedAgent.lifecycleUid` in `manager.ts` records the manager's half: the comment states it is the
uid its lifecycle-keyed broker footprint carries and the only incarnation its teardown credential may
name, so a replayed teardown cannot reach a same-name successor because its uid differs.

The complementary run-level fence already exists too, for hosted workflow runs rather than seats.
`RunJournalActivation` in `packages/core/src/run-journal.ts` carries `holder`, `fencingToken` and
`epoch`, and `assertMayActivate` refuses a takeover under a token older than the last recorded one,
refuses an equal token held by a different holder, and refuses an equal token at a different epoch,
with the reasoning that a lease binds one worker per attempt. `activateRun` publishes the activation
with `publishFenced` against the replayed last sequence, and its comment names the line: before that
PubAck this driver has performed nothing, after it the run's subject is its own until someone else
activates. `RunSuperseded` is thrown when a later append is refused, and its message says the driver
is finished either way and must not retry with a refreshed sequence.

That is the right shape and the seat path does not have it.

### 3.2 The manager's generation

What the manager persists today is not a generation. `ManagerInstanceIdentity` in
`packages/workspace/src/auth-paths.ts` holds `instanceId` and `serveIdentity` only. Its comment
states the intent: the logical instanceId is stable across restart so that a restart re-registers the
same id with an advanced epoch and the fence bites. `loadManagerInstanceIdentity` refuses a
malformed file loudly rather than minting a fresh id over it, with the message that a restart must
preserve the logical instanceId, and `createManagerInstanceIdentity` publishes by exclusive create so
that of N concurrent creators one wins and the losers adopt the winner or refuse with
`manager-instance-identity-create-lost`.

The epoch itself is not in that file. It is derived at registration:
`completeFrozenRegistrationFromSpec` in `packages/core/src/endpoint-service.ts` computes
`processEpoch` as the gate's current epoch plus one, except at revision 0, and
`registerManagerRemotely` in `implementations/manager/src/remote-register.ts` returns
`registrationRevision` and `processEpoch` from that registration. `SpawnAcceptance.executor` in
`manager.ts` carries `{ lifecycleUid, epoch }` as the manager incarnation a spawn's terminal fences
on. So the manager has an epoch per registration, and it is a manager-level coordinate.

A seat that moves between hosts needs a coordinate of its own, and this is the design's addition:

**A per-seat writer generation, persisted beside the manager instance identity, advanced on every
transfer of custody.** It belongs in `packages/workspace/src/auth-paths.ts`, beside
`ManagerInstanceIdentity`, for three reasons that the existing file already establishes. It is
space-scoped by a hex key there, because an auth dir is a shared namespace and a raw space token can
collide or change case under a different locale. It is published by exclusive create, so concurrent claimants resolve to one
winner. And a malformed record fails loud rather than being replaced, because minting over it is
how a stale host would become authoritative again.

The generation is not a second identity. The seat's identity stays its `lifecycleUid`, unchanged
across the move, because the durables are keyed by it and `ManagerResumeIdentity` requires the resume
to recover it. The generation says which custody of that one identity is current.

### 3.3 The handover

Custody transfer, in order:

1. **Source fences and proves the stop.** The existing steps 1 through 6 of section 1.3. The seat's
   process is gone and proven gone through `AgentHandle.waitForExit`. This is the only step that
   makes a handover safe without a distributed lock: the writer is not racing, it is dead.
2. **Source seals the checkpoint at the current generation.** The checkpoint records the generation
   it was cut at.
3. **Destination admits the checkpoint** through section 2's three gates.
4. **Destination advances the generation** by exclusive create on the successor value, before it
   launches anything. A create that loses means another destination is already claiming this seat,
   and the loser refuses rather than adopting. This mirrors `createManagerInstanceIdentity`.
5. **Destination launches**, recovering the recorded `lifecycleUid`, so the resumed endpoint binds
   the same lifecycle-keyed durables and passes the broker's lifecycle proof in `CotalEndpoint.start`.
6. **Destination proves the seat is the one it meant to resume**, per section 5.

A returning source host is then wrong on two independent axes. Its persisted generation is behind, so
its own admission refuses before it launches. And if it launches anyway, the broker is the backstop:
a manager-level operation rides its registration, which `completeFrozenRegistrationFromSpec` has
advanced past, and a seat-level write rides a lifecycle-keyed name whose grants were minted for the
incarnation at the broker.

The residual honest gap is a source host that restarts the *same* incarnation from a stale local
record while the destination is live. The uid alone does not separate them: both present a valid uid
and the same names. What separates them is eviction, and the code already has the shape:
`makeManagerEndpointEvictionEvidence` in `implementations/manager/src/endpoint-evict.ts` builds an
`evict(holderPrincipal) → verifiedGone` over the delivery daemon's `ctl.delivery-admin` rail, with a
per-call scoped credential, and treats a refusal, a garbled result, an internally contradictory
result, or an unreachable rail as not verified. Its comment states the rule: verified-gone is
conclusive only as scan complete with none remaining, and no oracle is loud. A destination that
cannot obtain verified-gone evidence for the predecessor principal must refuse the resume rather than
launch a second writer. This is the part of the fence that is a distributed fact and cannot be
established from a local file.

### 3.4 Why not a lease

A time-based lease was considered and is not the mechanism here. A lease is an assertion about a
clock and it fails open when the clock is wrong, which is the failure mode a single-writer fence
exists to prevent. The generation is monotonic, and monotonicity survives a clock that is wrong.

The manager lease in `packages/core/src/lease.ts` is the local evidence for this. `ManagerLeaseInfo`
is documented as per-instance liveness rather than a per-space singleton, keyed by `instanceId`, with
the note that a second manager's create no longer throws because a distinct instance id is a distinct
key, and losing the key stops that instance only. `MANAGER_LEASE_TTL_MS` in `streams.ts` is 10000,
and its comment is explicit that past the TTL the key expires at the broker while the holder keeps
serving and puts it back when the broker answers again, and that nothing there ends the holder's
process. A lease that does not stop its holder is liveness information, not a fence. The design uses
it as liveness information and nothing more.

## 4. Interrupted effects

Work in flight at the cut falls into three classes with genuinely different answers. Conflating them
is the main way a recovery design goes wrong, so they are separated here.

### 4.1 A run step

A hosted workflow run already has the machinery, and the design adds nothing to it.

`JournalEntry` in `packages/lang/src/journal.ts` carries `run`, `scope`, `kind`, `name`,
`occurrence`, `inputHash`, `requestId`, `attempt`, `state`, `status`, `result`, `error` and
`external`. The `requestId` field's comment states the rule: it is the identity the handler submits
under, written at `begin` rather than reported back after the fact, and recovery reissues under it.
`external` is documented as the external resource this effect bound, so a crash mid-effect is
recoverable.

The write is two-phase, in `performEffect` in `packages/lang/src/perform.ts`. On a `miss` or
`refused` verdict it awaits `host.journal.begin(key, inputHash, now, reqId)` before the work is
issued, with the comment that the request id has to be durable before the work is issued or a crash
in the gap leaves real work that nothing in the journal names. After that await it re-checks
cancellation, because the append is a gap during which a sibling can cancel this branch, and the
measured failure was a cancelled branch's effect still being dispatched and recorded `ok`.

`requestId` in `packages/lang/src/keys.ts` derives the identity from the run, the step key, the input
hash and the attempt, which `implementations/runtime/src/mesh-handler.ts` restates in its header as
`base64url(sha256(runId, stepKey, inputHash, attempt))`, noting it is a valid subject token by
construction so a resumed run re-derives the same token and attaches to the pause the crashed attempt
recorded instead of opening a second one.

`LookupVerdict` in `journal.ts` is what a resume does with each entry: `replay` returns the recorded
result and performs nothing, `replay-failed` throws the recorded error, `refused` runs live as a
fresh attempt, `pending` re-binds to `entry.external` and awaits its terminal, and `diverged` aborts
and mutates nothing. So a step interrupted mid-flight is `pending`, and `perform.ts` reads
`verdict.entry.external` into `ctx.resume` and reuses `verdict.entry.requestId` rather than
re-deriving, with the comment that re-deriving agrees whenever nothing moved, which is why it read as
correct, and that a resumed run which re-derives is reissuing under an identity the far side may
never have seen.

Two of the ten `EFFECT_KINDS` in `packages/lang/src/primitives.ts` are worth naming for how they
survive a repeat:

- `notify` is idempotent by derived id. `MeshHandler.notify` in `mesh-handler.ts` derives each notice
  id from the step's request id and the addressee, and its comment states one call to N agents is N
  records so a crash between the second and third write is repaired by re-running: the first two
  creates find their own bytes and return, the third happens. It also binds the instant rather than
  re-reading the clock, because `writeRunNotice` is create-only and compares canonical bytes, so a
  second pass carrying a fresh clock reading would conflict on the notice the first pass wrote and
  wedge the run on the one effect whose whole design is that re-running it is safe.
- `spawn` is idempotent by goal id. `MeshHandler.spawn` pins the envelope id to `ctx.requestId`, and
  the manager binds its goal under that id, so a resumed run that re-submits is served the recorded
  acceptance instead of allocating a second seat. The acceptance is bound as the entry's external
  state before the terminal is awaited, so a crash mid-await resumes into the poll and must not
  re-invoke.

The durability boundary is also already correct, and the design relies on it. `RunJournalStore.append`
in `implementations/runtime/src/journal-store.ts` translates a barrier failure into
`RunJournalUnavailable`, and its header states the rule: the language reads a store refusal as the
run losing its ability to record, never as an effect result, and a store that could return to the
interpreter after a barrier failure would be worse than one that throws because the interpreter would
carry on driving a run this process no longer speaks for. `RunJournalUnavailable.indeterminate` is
set for `RunJournalStalled` and not for `RunSuperseded`, because a refusal is determinate and a
stalled append is not. `perform.ts` keeps the handler's dispatch and the settling append in separate
failure domains for the same reason, with the comment that one `try` around both produces the worst
bug a journal can have: a `[pending, settled:failed]` sequence for work the world actually did.

**The constraint a cross-host move imposes.** `docs/cli.md` (Backups) records that the endpoint
submissions, facts, events, timers and workflow state streams are nonportable control state, and that
restore recreates them empty with their canonical configs before exposing the normal listener, so
active endpoint runs, lifecycles and sessions do not cross a backup. A run's journal therefore does
not travel with a space backup. Within one live space a run survives a driver change through
`activateRun`, and `RunDriver`'s `adopted` hook is documented as repairing external state bound to
the previous holder, specifically timers, because a checkpoint's armed schedule fires onto a subject
derived from the instance and epoch that armed it, so a run adopted by another host has live timers
firing where nobody is listening. A seat checkpoint does not carry a run, and this design does not
claim it does.

### 4.2 A mesh send

A message the seat sent, or was delivered, at the instant of the cut is not a journalled effect.
Delivery is durable at the broker, and the seat's acknowledgement is what decides whether a redelivery
is a duplicate.

`docs/connect-pi.md` documents the strictest shipped instance. The pi adapter uses three distinct
proof points: the matching custom `message_start` proves pi dequeued the batch locally, a `context`
event containing that exact batch proves it entered one provider request, and a successful
`after_provider_response` proves acceptance early where the transport exposes an HTTP response, with
a following clean terminal assistant boundary standing in where it does not. Only provider-confirmed
ids become eligible for acknowledgement, and only at a terminal agent boundary. The commit goes
through `MeshAgent.drainInboxIds()`, which removes only exact matches even when quiet ambient is
interleaved or older ids were overflow-evicted, and missing confirmed ids are marked handled and
tombstoned so late copies cannot resurface.

That page also states the recovery rule for the ambiguous case, and this design adopts it verbatim
rather than inventing a better one: pi emits `agent_end` without exposing whether it will retry, so
error, abort, unknown reasons and zero or missing output retain the delivery association in
`waiting`, and in managed headless use restart is the safe recovery because it terminates any
possibly-live provider call before durable redelivery.

So for a cross-host resume: an unacknowledged inbound message is redelivered, because the cut did not
acknowledge it. That is correct and is the reason the leave hooks are suppressed at step 5 of section
1.3, which keeps the seat's durable consumer alive rather than deprovisioning it. On a cross-host
move the redelivery window is wider, for the reason section 1.3 records: the durable is rebuilt at
its conservative contiguous ack floor by `consumerConfigFromCheckpoint`, so anything acknowledged out
of order above that floor returns as well. An outbound send that was in flight is
at-least-once with no stronger claim, and this design does not manufacture one. A seat whose last
act before the cut was a channel post may post again on resume. The mitigation is the harness's own
ledger and nothing in Cotal.

### 4.3 A tool call

A tool call inside a harness turn has no Cotal-level record. The run journal's `turn` is one entry
covering the whole turn; the tool calls inside it are the harness's business and Cotal never sees
them as steps. `LaunchSpec.sessionStatePath` is explicitly limited in its own comment to containing
no transcript and no credential, currently just pi's session id.

The consequence, stated rather than softened: a seat cut in the middle of a tool call resumes with
that call's effect on the world already done, or half done, and no Cotal record that it happened. The
harness's own transcript may or may not show it, depending on when the harness flushes.

Three things follow, and none of them is a mechanism this design can add:

- A repository-mutating tool call is covered by the repository half of the checkpoint, because the
  tree is captured after the harness is proven dead. Whatever the call wrote is either in the tree at
  the cut or it never landed. This is why step 7 of section 1.3 is ordered after step 6.
- An externally-mutating tool call (an HTTP request, a payment, an email) is not covered by anything.
  A checkpoint cannot make it idempotent and this design does not claim to.
- The operator-facing consequence is that a cut is safest at a turn boundary. The current code has no
  way to request one: `Manager.runPreservation` hard-stops with
  `handle.stop({ graceful: false })` deliberately, so that connector leave hooks do not run. A
  turn-boundary cut would need a cooperative pause the connector contract does not have. Naming that
  as absent is more useful than describing a quiesce step that no connector implements.

## 5. Per-harness reopening

Whether a seat can be continued at all is a per-harness fact, and the manager is required to read it
from a declaration rather than infer it. `sessionContinuityClass` in `packages/core/src/connector.ts`
is the classifier: `supportsSessionContinuation` gives `exact`, else `supportsResume` gives `fork`,
else `supportsFreshStart` gives `fresh`, else `drain-only`. Its doc comment states the discipline
directly: classify from declared capabilities only, a host throwing while probed is not capability
evidence, and connector names are deliberately not part of the decision.
`legacyManagerReport` in `implementations/cli/src/lib/legacy-manager-report.ts` follows it, treating
an unresolvable connector as `undefined` with the comment that unknown capabilities are default-deny
and therefore drain-only, and that no continuation promise may be inferred from a package name, an
implementation probe or a host-local heuristic.

### 5.1 pi declares exact continuation

`piConnector` in `extensions/pi/src/connector.ts` declares both `supportsResume: true` and
`supportsSessionContinuation: true`. It is the only shipped connector that declares the second.

`buildLaunch` renders the distinction between the two as different arguments. It refuses `resume`
together with `continueSession` as mutually exclusive. It pushes `--fork` for `opts.resume`, with the
comment that operator resume is a fork so pi creates a new session and leaves the source transcript
untouched, and `--session-id` for `opts.continueSession`, described as the opposite operation:
reopen the exact already-meshed session rather than forking it again. With neither, it mints a fresh
`randomUUID()` and passes it as `--session-id`, so a fresh managed seat has a recoverable session
identity before its first turn, because pi otherwise creates no session until a turn starts. The
expected id is exported as `COTAL_PI_EXPECTED_SESSION`.

The file set that reopens a pi session by id has two parts, and only one of them is named in this
repository.

**Named here, the pointer.** `buildLaunch` computes
`sessionStatePath` as `<workspaceRoot>/.cotal/pi-sessions/<name>-<lifecycleUid>.json`, creates the
directory with `mkSecretDir` and removes any stale file at that path. The seat writes it:
`persistSessionId` in `extensions/pi/src/extension.ts` writes
`{ version: 1, sessionId, status }` atomically through `writeSecretFileAtomic`, on `session_start`
and again with `status: "quit"` on `session_shutdown` when the reason is `quit`. `sessionStatePath`
in that file prefers `COTAL_PI_SESSION_STATE` and derives the same lifecycle-keyed path from
`COTAL_AGENT_FILE`, `COTAL_NAME` and `COTAL_LIFECYCLE_UID` as an upgrade path, refusing unless the
directory names check out as `.cotal/agents`.

**Not named here, the transcript.** pi's own session store is the harness's, and this repository does
not state its location. The connector never reads it, and `LaunchSpec.sessionStatePath` is documented
as carrying no transcript. So the checkpoint's harness store component for pi is an operator-supplied
path set, recorded by size and digest, and the design does not invent a default. Writing one here
would be a guess presented as a fact.

The manager's binding of the pointer is worth recording, because it is the pattern section 5.4
generalizes. `Manager.armSessionRecovery` awaits `awaitManagedSessionState`, refuses when the status
is not `running` with `connector reported a deliberate quit before readiness completed`, then calls
`awaitRecoveredSession` and only then sets `restart.armed`. `Manager.awaitRecoveredSession` queries
the seat's authenticated control socket through `controlSession` in
`implementations/manager/src/control-session.ts` and throws
`replacement reported session <x>, expected <y>` on a mismatch. The comment on `armSessionRecovery`
states the division: the file proves the latest in-process session including a pi `/resume`, and the
authenticated socket proves this process owns that session now, and both are awaited within a bounded
window because presence may lead `session_start` by milliseconds.

`Manager.recoverManagedSession` is the same-host use of all this. It reads `continueSession` through
`readManagedSession` only when the connector declares `supportsSessionContinuation`, launches with
`resume: undefined, prompt: undefined, continueSession`, and awaits `awaitRecoveredSession`.
`SESSION_RESTART_LIMIT` is 3 and `SESSION_RESTART_WINDOW_MS` is 120000, and exceeding the budget logs
a crash loop and retires the seat through `freeSlot`. `Manager.onAgentExit` gates entry: it returns
early when `maintenanceState` is not `active`, with the comment that preservation owns the child-stop
snapshot and exit watchers must neither delete it nor trigger deprovision while the cut is forming.

There is one upgrade seam that the design should not restate as a general mechanism.
`Manager.retainedSessionId` reads `entry.launch.sessionId` first and, for a continuation-capable
connector without one, falls back to reading
`<workspaceRoot>/.cotal/pi-sessions/<name>-<lifecycleUid>.json` directly, refusing loudly with
`Reload the live Pi seat before the preservation cut; refusing to resume fresh and lose its context`.
It is a bridge for inventories written before `sessionId` existed, and a cross-host checkpoint should
carry the id explicitly rather than depend on it.

One detail matters for section 6's procedure. `Manager.resumeEntry` writes
`sessionId: a.restart?.armed ? this.readManagedSession(a) : a.launch.sessionId`. So the live state
file is consulted only while recovery is armed; otherwise the recorded launch value is used. An
operator verifying a checkpoint should read the id from the inventory and not assume it was refreshed.

### 5.2 Claude Code forks rather than continues

`claudeConnector` in `extensions/connector-claude-code/src/extension.ts` declares
`supportsResume: true` with the inline note that it renders `--resume <id> --fork-session`, described
as fork-from and never hijack. `buildLaunch` pushes `args.push("--resume", opts.resume,
"--fork-session")`. It does not declare `supportsSessionContinuation`, and its first guard is
`if (opts.continueSession) throw new Error("claude connector does not support exact-session
continuation")`. It supplies no `sessionStatePath`: its `buildLaunch` returns `command`, `args`,
`env` and `control` only.

So `sessionContinuityClass` gives `fork`, and the honest statement is that a Claude Code seat cannot
be continued across hosts. It can be forked from a transcript, which produces a new session with the
old history and a new id. That is a different thing and this design does not let a checkpoint present
it as continuity. A resumed Claude Code seat is a fork, its session id differs from the recorded one,
and the checkpoint must say `fork` so an operator is not told a fork is a continuation.

The transcript location is also not established by this repository's shipped code.
`~/.claude/projects/` and `~/.claude/history.jsonl` appear in `extensions/connector-claude-code/src/agui-map.ts`
as commentary about what Claude Code writes, and in that package's smoke files, which state that
walking `~/.claude/projects/` is deliberately avoided. The shipped connector never reads a transcript
path, so for a Claude Code seat the harness store component is operator-supplied in the same way as
for pi, with the additional caveat that reopening by id is not available regardless.

### 5.3 jcode declares neither flag

`jcodeConnector` in `extensions/connector-jcode/src/extension.ts` declares
`supportsModelVariant` and `supportsToolListAnnounce`, and neither continuity flag. It refuses both
inputs: `continueSession` because its private Harness API instance is retired with the seat, and `resume` with `the private Harness API instance never shares a session with another seat`. So `sessionContinuityClass` gives `drain-only`, the default-deny
outcome, because `supportsFreshStart` is also absent.

The reopening that does happen is entirely inside the connector's host and is not addressable by id
from outside. `privateAgentHome` in `extensions/connector-jcode/src/host.ts` derives the seat's home
as `<COTAL_JCODE_HOME>/.cotal/jcode/<slug>-<12 hex of sha256(space\0name)>`, refuses a path that
escapes the managed root, refuses symlinks along the way, and hardens it to 0700. The host then calls
`inspectStoredSessions` and, unless the directory is empty, `chooseSessionToResume(await
client.listSessions(), cwd)`. `storedSessionsPath` in
`extensions/connector-jcode/src/stored-sessions.ts` is `<jcodeHome>/sessions`.
`chooseSessionToResume` in `extensions/connector-jcode/src/session-resume.ts` requires a candidate to
declare a `working_dir` equal to the seat's cwd, to not be archived, and to carry `transcript_bytes`
greater than zero, then takes the largest transcript. Its doc comment states the rule the design must
respect: resuming the wrong session is worse than starting clean, because a seat that silently
inherits another lane's context will act on it with full confidence.

This is a heuristic over a private home, keyed on the home path and the cwd, which is precisely what
a cross-host move changes. A jcode seat moved to another host with the same home path and cwd may
reattach to a transcript; moved anywhere else it starts fresh and says so. The design does not paper
over this. A jcode seat is `drain-only`: drain it, move it, and accept a fresh session, or do not move
it.

### 5.4 The rule the three cases produce

A checkpoint records the continuity class from `sessionContinuityClass` over the connector's declared
flags, and a destination refuses to promise more than the class allows.

- `exact`: the destination must prove the reopened session is the recorded one. The proof is the one
  `Manager.awaitRecoveredSession` already performs, over the connector's authenticated control
  socket, with a mismatch as a failure and not a warning.
- `fork`: the destination records that the session id changed and reports a fork. It does not claim
  continuity.
- `fresh` and `drain-only`: the destination does not reopen a session at all. The checkpoint's
  repository half and launch profile still apply, and the transcript does not travel.

The discipline is `sessionContinuityClass`'s own: never infer a class from the connector's name,
never from a probe of a live host. A connector that would let a manager continue it across hosts has
to declare `supportsSessionContinuation` and supply a `sessionStatePath`, and until it does, its
seats are not continuable however plausible their file layout looks.

## 6. Two-host validation with pi

A procedure an operator runs to distinguish a real continuation from a silent fresh session. pi
because it is the only connector that declares `exact`. Two hosts of the same architecture, host A
and host B, each with a Cotal checkout and the pi binary the version pin in `docs/connect-pi.md`
names. The seat's workspace root is `$ROOT` on both.

The commands below are the shipped surface: `cotal up`, `cotal spawn`, `cotal ps`,
`cotal down --preserve-state`, `cotal backup create` and `cotal up --restore` as `docs/cli.md`
documents them. The checkpoint components this design adds (the repository bundle, the delta and the
harness store) have no command yet, so steps 5 and 7 name what an operator copies rather than a flag
that does not exist. Saying which steps are manual is the point of writing the procedure down.

### Step 1 on host A. Bring the mesh up

```bash
cd "$ROOT"
cotal up --detach
```

### Step 2 on host A. Spawn a pi seat

```bash
cd "$ROOT"
cotal spawn default --detach --agent pi --prompt "Remember the phrase juniper-ledger-41. Reply with it."
```

`--agent pi` selects `piConnector`. The prompt is pi's initial message: `buildLaunch` pushes it as
the last positional and refuses an empty prompt or one starting with `-` or `@`, so a prompt that
pi's parser would misread cannot be delivered as a turn.

The phrase is the continuity probe. It exists only inside the transcript. It is not in the persona,
not in the launch profile and not in the inventory, so a fresh session cannot produce it from
configuration.

### Step 3 on host A. Record the pre-cut facts

```bash
cd "$ROOT"
cotal ps --json
cat "$ROOT/.cotal/pi-sessions/"*.json
```

`cotal ps --json` prints one JSON object per seat per line, copied unchanged from the manager row
(`docs/cli.md`, Managed seats). Keep the seat's name and its lifecycle uid.

The state file is what the pi extension wrote through `persistSessionId`. Its content is
`{"version":1,"sessionId":"…","status":"running"}`, the closed shape
`Manager.readSessionStatePath` parses. Record the `sessionId`. This is the value continuity is
measured against.

### Step 4 on host A. Take the cut

```bash
cd "$ROOT"
cotal down --preserve-state
```

`docs/cli.md` (down) records what this does: it fences the manager, retains principals and durable
state, stops and proves the stack down, then publishes `ready`. It is bare-whole-stack only. Under
the hood it is `Manager.preparePreservation`, the coordinator's fsync of the inventory, and
`Manager.commitPreservation`, whose `Manager.runPreservation` stops each child with
`graceful: false` and proves exit through `Manager.awaitHandleExit`.

A partial cut never publishes `ready`, so the absence of `ready` is a refusal to proceed and not a
condition to work around.

### Step 5 on host A. Capture the checkpoint

```bash
cd "$ROOT"
cotal backup create "$ROOT/../ckpt-space" --store-dir "$ROOT/.cotal/nats"
```

That command produces the space artifact. `docs/cli.md` (Backups) records that it is offline-only and
requires the stable `ready` record from the previous step, an exact store match, no live recorded
process and an unreachable exact endpoint, and that `manifest.json` is written last with exact sizes
and sha256 values.

The three components this design adds are captured here, by hand, and only now, because the harness
is proven dead:

```bash
cd "$ROOT"
git bundle create "$ROOT/../ckpt-repo.bundle" --all
git rev-parse HEAD > "$ROOT/../ckpt-repo.base"
git status --porcelain=v1 -z > "$ROOT/../ckpt-repo.delta-list"
sha256sum "$ROOT/../ckpt-repo.bundle" "$ROOT/../ckpt-repo.delta-list"
```

Then copy the pi session store, whose path is an operator input for the reason section 5.1 gives:
this repository does not name it, and the design does not invent it. Digest whatever is copied.

Also copy `$ROOT/.cotal/pi-sessions/` and the maintenance tree the cut wrote. `maintenancePaths` in
`packages/workspace/src/maintenance.ts` gives their locations:
`.cotal/maintenance/v<N>/journal.json` and `.cotal/maintenance/v<N>/resume.json`. The resume document
is the inventory `Manager.resumePreserved` will be handed, and `readMaintenanceResumeDocument`
verifies its size, mode, sha256, version and JSON shape against the descriptor recorded in the
journal, refuses a symlink, and refuses when the file changed while being read.

### Step 6 on host B. Admit the checkpoint

Run section 2's gates before anything is started. Integrity: every copied file matches its recorded
size and digest. Identity: the recorded space matches, and the recorded lifecycle uid is not live
here. Recency: `capturedAt` is inside the declared horizon.

The identity material has to be resolvable on host B, for the reason section 1.2 gives: a checkpoint
carries credential references, not credentials. In `static` mode that is
`ManagerResumeIdentity.credential.path` with its recorded sha256, and
`Manager.inventoryReferenceError` will refuse with `retained reference unavailable` or `retained
identity file is not private (expected 0600)` if it is absent or loose. Placing it is the operator's
job and out of this design's scope.

### Step 7 on host B. Restore the repository state

Apply the bundle at the recorded base commit, then the delta, in the seat's `cwd`. A bundle that does
not apply to the recorded base is a refusal, not a merge. This is manual for the reason given above:
no command carries these components yet.

This comes before the resume deliberately, and the earlier draft of this record had it after. A seat
resumed in step 8 may take a turn as soon as it is ready, and a turn against a tree that has not been
restored yet acts on the wrong repository with full confidence. The tree is a precondition of the
seat, not a follow-up to it, which is the same ordering rule step 5 of section 1.3 applies at the
other end: capture after the harness is dead, restore before it is alive.

### Step 8 on host B. Drive the resume

```bash
cd "$ROOT"
cotal up --restore "$ROOT/../ckpt-space" --detach
```

Two preconditions hold here and neither is created by this command. `docs/cli.md` (Backups) records
that restore requires the same space and existing trust state, and states plainly that restore never
creates fresh auth: an authenticated restore validates the space trust bundle before staging,
including nkeys, seed matches, JWTs, signers and space binding. So host B must already be a member of
this space's trust chain. And the resume document has to be present, because
`Manager.resumePreserved` is handed an inventory rather than discovering one:
`readMaintenanceResumeDocument` in `packages/workspace/src/maintenance.ts` reads the fixed
`.cotal/maintenance/v<N>/resume.json` path and verifies it against the descriptor in the journal.
Both are the operator inputs section 1.2 refuses to move, for the reason given there.

`docs/cli.md` (Backups) records the sequence this drives: after listener readiness the manager starts
attempt-bound, validates retained credentials and tokens without granting or reprovisioning, and
resumes the exact persisted principals under cleanup suppression; `commitResume` is an idempotent
validation barrier returning `awaitingFinalize` with an attempt-bound 64-hex token and does not
release suppression; the CLI fsyncs that evidence, then calls token-bound `finalizeResume`, and only
an `active` response for the exact token releases suppression.

In the code that is `Manager.resumePreserved`, then `Manager.opCommitResume` into
`Manager.commitResumeActivation`, then `Manager.opFinalizeResume`, whose argument parser
`parseResumeFinalizeArgs` in `resume.ts` requires `durableCommitToken` to match `/^[a-f0-9]{64}$/`.

### Step 9 on host B. Prove continuity

Three observations. All three must hold. Any one of them alone is defeatable.

**Observation 1, the session id is the same.**

```bash
cd "$ROOT"
cat "$ROOT/.cotal/pi-sessions/"*.json
```

The `sessionId` must equal the value recorded in step 3. A different id means pi opened a different
session, which is either a fork or a fresh start, and the transcript did not continue.

This is the observation the manager itself makes on the same-host path, and it is worth knowing that
it is enforced there rather than merely displayed: `Manager.awaitRecoveredSession` throws
`replacement reported session <reported>, expected <expected>` on a mismatch. On the pi side there is
a matching guard: the `session_start` handler in `extensions/pi/src/extension.ts` throws
`pi connector: expected session <expected>, host opened <actual>` when the runtime's expected id does
not match, and the startup path throws the same way against `PI_SESSION_ID`.

**Observation 2, the lifecycle uid is unchanged.**

```bash
cd "$ROOT"
cotal ps --wide
```

`docs/cli.md` (Managed seats) records that `--wide` prints the lifecycle uid among the extra
operational facts. It must equal the value from step 3. A new uid means a new incarnation, and the
durable inbox from before the cut belongs to the old one: `EndpointOptions.lifecycleUid` documents
the durables as keyed by the uid, and `ManagerResumeIdentity` states that a resume must recover it
rather than mint a fresh one or a later teardown would orphan the real durables.

A resumed seat that reached presence at all is already evidence here, because of the broker proof in
`CotalEndpoint.start`: an authed registering agent whose uid names a durable that is not at the
broker throws `lifecycle proof failed` and never publishes presence. So a wrong-uid seat does not
appear in `ps` with a mesh row; it fails to come up.

**Observation 3, the transcript answers.**

Send the seat a direct message asking for the phrase from step 2, and read the reply. A continued
session answers `juniper-ledger-41`. A fresh session cannot, because the phrase exists only in the
transcript.

### The look of a silent fresh session

Recorded here so that the failure is recognizable rather than reasoned about after the fact:

- the state file carries a `sessionId` that differs from step 3;
- `ps --wide` shows the seat running and the mesh row present, because a fresh seat is a perfectly
  healthy seat;
- the phrase probe fails, or the seat asks what the phrase was.

Observation 3 alone is the one that catches it in practice, and observations 1 and 2 are what make it
diagnosable: id changed means the harness did not reopen, uid changed means the manager did not
re-adopt the incarnation.

### The limits of this procedure

It does not prove the fence. One seat moved once, with the source stack down, exercises the happy
path. The fence is tested by starting host A's stack again after step 8 and confirming host A's seat
cannot write as that identity. That is the check section 3.3 exists for, it needs the eviction
evidence path described there, and it is a different procedure from this one.

It also does not prove interrupted-effect behavior. The cut in step 4 happens while the seat is idle.
A cut during a live turn is the case section 4.3 names as uncovered, and no observation in this
procedure would detect a tool call that landed on the world and left no record.

## Open points

Named so that a reader does not mistake absence for completeness.

1. **The repository bundle has no command.** Steps 5 and 7 are manual. The capture rule for untracked
   files is declared in the checkpoint, and a destination that cannot reproduce that rule refuses,
   but nothing enforces the rule at capture time.
2. **The per-seat generation is not implemented.** Section 3.2 names the file it belongs in and the
   publication primitive it must use. Today only `instanceId` and `serveIdentity` are persisted in
   `packages/workspace/src/auth-paths.ts`, and the epoch is derived at registration.
3. **The freshness horizon is a new field with no shipped reader.** Nothing in the current admission
   path reads a clock.
4. **pi's transcript location is an operator input.** This repository names the pointer file and not
   the store. Any default written here would be a guess.
5. **A turn-boundary cut is not expressible.** The connector contract has no cooperative pause, and
   `Manager.runPreservation` hard-stops deliberately so that leave hooks do not run.
6. **Two of three shipped harnesses are not continuable.** Claude Code is `fork`, jcode is
   `drain-only`, by their own declarations in `extensions/connector-claude-code/src/extension.ts` and
   `extensions/connector-jcode/src/extension.ts`. Cross-host seat continuity is a pi capability
   today, not a Cotal capability.
7. **Inbound delivery is at-least-once across a cross-host move, not at the same frontier.** The
   durable is rebuilt at its contiguous ack floor by `consumerConfigFromCheckpoint` in
   `packages/core/src/backup.ts`, so an acknowledgement taken out of order above that floor is
   redelivered. Nothing in this design narrows that, and section 4.2 leaves the burden with the
   seat's own ledger.
