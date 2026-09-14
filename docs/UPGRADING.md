# Upgrading a running deployment

> **Guide** (informative) · **For:** operators upgrading a mesh that already exists · **See also:** [Substrate stability](stability.md), [Run a mesh](run-a-mesh.md), [Identity and auth](identity-and-auth.md)

[Substrate stability](stability.md) tells you what the version numbers promise. This page is the
other half: what to actually do when the deployment already exists, has credentials in it, and
cannot simply be recreated. Every release that breaks a running deployment gets a section here,
naming what migrates on its own, what does not, and the order to move the pieces in.

## The pre-1.0 upgrade contract

The packages are pre-1.0, so a minor bump may break an API or an on-disk expectation. Four
commitments make that survivable for someone with a fleet:

- **Pin an exact version.** `0.N.P`, never `^0.N.P`. A range can pull a breaking minor in during an
  unrelated reinstall.
- **Every break that touches a running deployment gets a section on this page**, written in terms of
  what an operator does, not in terms of which module changed.
- **Read the section before you start, not halfway through.** A section names the work up front
  precisely so the operation does not change shape once it is underway.
- **A break that cannot be made automatic says so.** Where credentials or state must be recreated by
  hand, the section says which ones and when, rather than leaving you to discover it at the moment
  the first one stops working.
- **A change to the shape of a credential, or to who may renew one, is breaking whatever the commit
  marker says.** This rule is stated because the marker is a judgement made while writing the code
  and the consequence is felt by someone running it a day later. A fleet that keeps authenticating
  looks compatible and is not, if nothing in it can renew. Any automated check of this rule would
  read commit markers, so a break recorded as a feature is the one case it could not see, which is
  why the rule is written for people first. **The marker held for this release: the 0.49.0 change
  that caused all of this, `36d177951 feat(core)!`, did carry its `!`.** The rule exists for the
  next one that does not.

What this page does not promise is a rolling upgrade. Nothing in the current line dual-serves two
authority versions, so where broker and manager run separately there is a window in which the mesh
is down. The sections below give that window's shape so it can be scheduled rather than endured.

## From 0.48.2 to 0.49.0

0.49.0 changes how a credential's authority is recorded. A credential is no longer only a signed
file: it is an *issuance*, with a generation the issuer chose and durable evidence of the ceiling it
was granted under. The important consequence for a running deployment is not at connect time. It is
at renewal time.

### What keeps working without any action

- **Existing agent credentials keep authenticating.** A credential minted under 0.48.2 is not
  revoked and is not rejected at connect. Nothing needs to be re-issued to bring the fleet back up
  after the upgrade.
- **The channel registry survives.** Channels, their replay settings, descriptions, and usage text
  are ordinary durable state and are not rewritten by the upgrade.
- **`cotal deliver` is still a standalone command.** Running the delivery daemon as its own process
  remains supported; it is not restricted to being a child of `cotal up`.
- **`cotal join` keeps its flags.** In particular `--lifecycle-uid` is not new in 0.49.0. It has
  been required alongside `--creds` since well before this release, and the pairing rule did not
  change here. A scripted external join that worked under 0.48.2 works unchanged.

### What does not migrate

**A credential minted before 0.49.0 cannot be renewed.** Managed agent credentials carry a
24-hour lifetime and the manager re-signs one once it passes **75%** of its life, ticking every
quarter of the TTL so a tick always lands inside that window. When the manager reaches a credential
that carries no issuance, it refuses to renew it and logs the agent by name:

```
! managed cred renewal <agent>: renewManagedStaticCred: <agent> carries no issuance;
  a static credential minted before SPEC 13.15 is not renewed under an unbound generation
  - respawn the agent
  - the agent dies loud at this cred's expiry unless it is reminted
```

So the fleet comes up fine, runs normally, and then each agent stops at its own credential's
expiry, within roughly a day of the upgrade, one at a time rather than together. The refusal is
deliberate: the renewal would otherwise have to invent a generation nobody issued, which is the
state the release exists to remove.

**Respawn the managed agents as the last step of the upgrade.** For this particular upgrade the
respawn is not optional: stopping a 0.48.2 manager ends its agent processes whichever CLI you use,
for the reason given under the outage window below. The respawn is how they come back, and it is
also what mints each credential as an issuance so it renews from then on. One planned pass over the
fleet is the whole job. Skipping it leaves agents stopped and, for any credential that survived
into 0.49.0 unminted, brings the renewal cliff above a day later, one agent at a time.

### Credentials you minted yourself

**A credential you minted with `cotal mint` is a different case, and it very likely needs
nothing.** The distinction that matters is not the word "static", which covers both. It is **what
minted the credential and who owns its renewal**. A credential the **manager** minted for an agent
it spawned carries a lifetime and is renewed by the manager, so it is the subject of everything
above. A credential **you** minted with `cotal mint` and handed to an external peer is issued with
**no expiry at all**, and no manager renews it: it is not in the sweep, so there is no renewal to
fail. It keeps working after the upgrade, and re-minting it would mean coordinating with a third
party for no gain.

The manager says which one it is holding. Where a credential has no expiry to reach, the sweep
names it and moves on rather than refusing:

```
! managed cred renewal <agent>: credential is unbounded - not renewed
  (a pre-TTL credential stays as minted until respawn)
```

Re-mint an external peer's credential only if you want it to carry a lifetime, and at a time you
choose.

### How to read the boot log

A 0.49.0 manager starting over an existing space may print lines like:

```
  verified evicted: <holder-key> (3/12)
  already verified (durable): <holder-key>
✓ boot self-heal: manager/<id> registration gate reopened at generation <n>
```

These are **not** a credential migration, and reading them as one is the most likely way to
conclude the fleet is fine when it is not. They come from the manager repairing **one** endpoint
registration gate that a previous restart left frozen, and they enumerate that single gate's
credential-family holders as it verifies each one evicted. `already verified (durable)` on a later
start is the repair cursor resuming, not a credential that became durable. The repair is real and
useful (it is what previously needed `cotal reconcile-gate` by hand), but it says nothing about
whether your agent credentials carry issuances. The renewal refusal above is the signal that does.

### Which side to upgrade first in a split topology

Move the manager first.

The stores 0.49.0 introduces are created by the **manager** at its own boot, not by the broker.
They are create-or-verify and idempotent, so a 0.49.0 manager brings the space's authority stores
up to the new shape itself, and it does so against whichever broker is answering.

Being honest about the evidence behind each direction, because they are not equally established:

- **Broker-first was measured on a live 30-agent deployment** (issue #1578). Upgrading the broker
  first locks the old manager out immediately: `cotal up` re-renders the broker's generated config
  from the trust record, and after the restart the still-0.48.2 manager is refused on every
  connection with an `authentication error` naming the Nkey, continuously. That text comes from the
  broker process, not from a Cotal command, so match on its shape rather than on an exact string.
  `cotal ps` reports zero agents while
  the agent processes are still alive, because the manager has lost its view of them, not because
  they died. Upgrading the manager clears it immediately.
- **Manager-first is reasoned from where the new stores are provisioned**, not from a measured
  fleet upgrade. It is the recommended order because the manager is the component that creates what
  0.49.0 adds, but it has not been run end to end on a production split topology at the time of
  writing. Treat it as the better-supported order rather than a guaranteed one, and keep the
  rollback below ready either way.

Whichever order you pick, **this is not a rolling upgrade**. Between the two steps the mesh is down
and the manager cannot see its agents. Go straight through rather than pausing between them, and
schedule it as an outage window.

### What the window looks like

- **The managed agent processes do not survive step 1, in either order.** This is the one place
  where the obvious reordering does not rescue you, so it is worth understanding rather than
  working around. Sparing agents on a bare manager stop is a **handshake**: a 0.49.0 manager
  publishes a capability file proving it can release its agents, and a 0.49.0 `cotal down` refuses
  the stop unless it finds one. **A 0.48.2 manager never publishes that file**, because the
  mechanism ships in the release you are installing. So the old CLI against the old manager sends a
  plain stop and takes every seat with it, and the new CLI against the old manager either refuses
  (leaving `--with-agents`, which reaps deliberately) or falls to the legacy path, warns that it
  cannot verify the manager can spare its agents, and signals it anyway.
- **You can confirm which side you are on in one command, without stopping anything.** The flag that
  marks the newer behaviour is absent from the older CLI, and its summary line makes the difference
  plain:

  ```
  $ cotal down --help          # on 0.48.2
  cotal down - stop the whole local stack, or name only the components to stop

  $ cotal down --help          # on 0.49.0
  cotal down - stop the whole local stack (managed agents stay running unless --with-agents), ...
  ```

  If your `cotal down --help` does not mention `--with-agents`, stopping the manager stops the
  agents with it.
- **Therefore the respawn in step 5 is mandatory recovery for this upgrade, not an optional pass.**
  It is also the step that re-mints credentials as issuances, so it is the same action either way.
  Plan the window to include it rather than treating it as cleanup.
- The **manager's view** of them is lost while the two sides disagree, so `cotal ps` reports zero
  and control commands do not reach seats.
- **Messages are not delivered** while the mesh is down.
- The window is as long as it takes to restart the second component, plus the manager's own start.
  It is minutes, not hours, provided you do not stop between the steps.
- **Nothing self-heals if you stop halfway.** The refusal is continuous until both sides match.

### Snapshot this before you start

Take these while the deployment is still on 0.48.2. The two `cotal` reads are live reads and must
happen before anything stops.

- **A filesystem or volume snapshot of both containers**, if your platform offers one. This is the
  only rollback that covers every case, and it is what the reporting deployment used.
- **`cotal backup create <dir>`**, for the durable space state, **but read the next paragraph before
  you rely on it**: on a split broker and manager topology it is very likely unavailable to you, and
  the volume snapshot above is your actual rollback.
- **The trust records and credential directory** under `.cotal/auth` on the manager host, including
  the per-space material directory. These are what a re-mint would otherwise have to replace.
- **A copy of the channel registry**, so you can verify it came back rather than assuming it did:
  `cotal channels list` before and after.
- **The output of `cotal ps`**, so you know how many seats you expect to see afterwards and can tell
  a lost view from a lost agent.

#### `cotal backup` on a split topology

**`cotal backup create` cannot read a running stack.** It requires a completed cut, and only
`cotal down --preserve-state` publishes one:

```
$ cotal backup create ./backup.0482
✗ backup requires a completed cut; run `cotal down --preserve-state` first
```

**And `cotal down --preserve-state` requires a manager alive on the host you run it from.** It uses
that manager to attest that every retained child stopped, and the check is deliberately fail-closed:
a manager that is dead or merely uncertain refuses rather than preserving an unproven cut. The check
reads a local pidfile, so a **remote** manager does not satisfy it. On a split topology the broker
host has no local manager, which means the documented durable-backup path is not available there.

**Measured rather than assumed, at 0.48.2**: the backup refusal above is executed output. The
preservation requirement is read from `down.ts` at the same tag, where the preserve path asks a
manager to prepare an inventory and then requires that manager to be locally alive before it
commits. The part not executed end to end is a genuine two-host split, which needs two real hosts.

**What to do instead.** Use the filesystem or volume snapshot of both containers. That is the
rollback the reporting deployment actually used, it covers the broker's durable state and the
manager's credential material together, and it does not depend on either component being able to
attest for the other. If you want `cotal backup` as well, take it from a host that does have a live
local manager, and understand it is a second copy rather than the primary rollback.

**This looks like a product limitation rather than a documentation gap**, and it is written here as
one so an operator is not left thinking they mis-typed a command. The upgrade path for the exact
topology this page is addressed to cannot use the documented backup command.

### The upgrade end to end

```bash
# 0. on 0.48.2, STILL RUNNING: record what you expect to see afterwards.
#    These two are live reads, so they must happen before anything stops.
cotal channels list > channels.before
cotal ps > ps.before

# 1. manager host. READ THE NOTE BELOW THE BLOCK FIRST: this step ends the
#    managed agent processes whichever order you choose, and the respawn in
#    step 5 is how they come back. It is recovery, not tidying.
#
#    STOP THE MANAGER WITH THE 0.48.2 CLI, BEFORE INSTALLING 0.49.0. The
#    order matters and it is not recoverable once you install: a 0.49.0
#    `down manager` REFUSES to stop a 0.48.2 manager whose pid record carries
#    a start token, which is every manager on a platform that can read one
#    (Linux can):
#      refusing bare manager stop: ... does not prove this manager can detach
#      its agents; use --with-agents or stop the agents explicitly
#    The refusal names two remedies and NEITHER clears it for this case. The
#    check reads a capability file that only a 0.49.0 manager writes; it never
#    counts agents, so stopping them first changes nothing. And `--with-agents`
#    is whole-stack only, so `down manager --with-agents` is refused by its own
#    flag rule. See #1592.
cotal down manager                        # the 0.48.2 CLI, still installed.
                                          # 0.48.2 has no --with-agents; this
                                          # is the whole route. On a host that
                                          # runs the whole stack, the 0.49.0
                                          # `cotal down --with-agents` after
                                          # installing is the alternative.
npm install -g cotal-ai@0.49.0            # ONLY after the stop above
#    `supervise` RUNS IN THE FOREGROUND and holds the terminal until you stop
#    it. There is no --detach on this command. Start it under whatever keeps
#    your manager alive normally (systemd unit, container entrypoint, or a
#    second terminal), and run the remaining steps from another shell.
cotal supervise --space <space> --server nats://<broker>:4222

# 2. broker host: stop the stack.
#    NOT `--preserve-state` on a split topology: it needs a manager alive on
#    THIS host to attest its children stopped, and yours is on the other one.
#    Your rollback is the volume snapshot from "Snapshot this before you
#    start", not `cotal backup`.
#    See "cotal backup on a split topology" above.
cotal down

# 3. broker host: install 0.49.0 and start it again
npm install -g cotal-ai@0.49.0
#    Record the manager log's size BEFORE starting, so step 3a can tell THIS
#    boot's output from every earlier one. It must be captured here, ahead of
#    the start: taken afterwards it sits past the new line and the wait hangs.
#    `<spaceKey>` is NOT the space name. It is lowercase hex of the name's
#    UTF-8 bytes, so space `prod` is `manager.70726f64.log`. Do not guess it:
#    `cotal up` prints the real path on its launch line. Substituting the
#    plain name points at a file that does not exist, and the wait below then
#    burns its full timeout before telling you.
LOG=.cotal/manager.<spaceKey>.log
OFF=$( [ -f "$LOG" ] && wc -c < "$LOG" || echo 0 )
cotal up --detach --host 0.0.0.0 --space <space>

# 3a. SPLIT TOPOLOGY ONLY, and do not skip it: there is no broker-only mode,
#     so the line above ALSO starts a local manager on the broker host. Wait
#     for the log to show the manager is up, then stop it, or you finish the
#     upgrade with two managers and the one you did not intend is the one
#     nobody is watching.
#     A bare `grep -q` does NOT wait: it reads once and exits 1 immediately
#     if the line has not been written yet. Bound the wait instead, so a
#     manager that never comes up fails loudly rather than reading as ready.
#     The log is opened APPEND-ONLY, so on any host that has run a manager
#     before, this file ALREADY carries a `manager up` line from an earlier
#     boot. Grepping the whole file therefore matches instantly and waits for
#     nothing. Read only what THIS boot appended, using the $OFF captured in
#     step 3 above (before the start, which is the only point it is correct):
timeout 60 bash -c \
  "until tail -c +$((OFF+1)) \"$LOG\" | grep -q '. manager up'; do sleep 1; done"
#     exit 0 = THIS boot logged it; exit 124 = it never did, so STOP and look.
#     This manager is 0.49.0 and publishes its own spare-capability file, so
#     the bare stop below is NOT the refusal case from step 1.
cotal down manager                                      # broker + delivery remain

# 4. verify the mesh is whole again before touching the fleet.
#    Do NOT compare `cotal ps` against ps.before yet: step 1 ended the agent
#    processes, so at this point it is EXPECTED to be empty, and an empty
#    `ps` is also the signature of the broker/manager mismatch described
#    above. The two are indistinguishable here, so compare what the mesh
#    itself should have carried across instead:
cotal channels list # compare against channels.before: this SHOULD match now
cotal ps            # expect it to be EMPTY here; ps.before is the target for
                    # step 5, not for this step

# 5. the step that is easy to skip: respawn the managed agents so their
#    credentials are re-minted as issuances and can renew. Persona is a
#    POSITIONAL argument here, unlike `cotal stop`, which requires --name.
#    One call per agent:
cotal spawn <persona> --detach --name <n> --space <space>
#    then the comparison step 4 could not make:
cotal ps            # NOW compare against ps.before: seat count should match
```

The mesh is down from step 2 until step 3 finishes. That is the window. On a split topology there is
no cut and no backup inside it, so the window is the stop, the install and the restart, nothing more.

## Adding a section for a future release

**Every changeset marked breaking adds a section to this page.** A release that changes what an
operator must do, in what order, or what stops working, is not finished until the section exists.
`scripts/upgrade-section-gate.mjs` grades a commit range for this: run it as
`pnpm upgrade-section-gate --base <ref>` and it reds when the range carries a breaking change and
adds no new release section. CI runs its self-test and, as a step of the `attribution` job, grades
each pull request's own range as `HEAD^1..HEAD` over the merge snapshot it checked out. That job is
the only context in the branch protection rule set, so a red gate FAILS A REQUIRED CHECK AND BLOCKS
THE MERGE. The section is not optional and a reviewer cannot wave it through without an
administrator overriding branch protection. Be precise about what the check proves either
way, because one trusted past its evidence is worse than none. It proves a section for a release
**was written here**. It cannot prove the section is **correct**, or that it describes the break
that actually landed, and it cannot see a breaking change that carries no marker at all. Reviewing
the words remains a person's job.

**Mark the break, or the gate cannot see it.** Any one of these is enough, and they are the only
things it reads:

- a `!` before the colon in the commit subject, as in `feat(core)!: bind hosted runs to the caller`
- a `BREAKING CHANGE:` footer in the commit body
- a changeset in `.changeset/` declaring a `major` bump for any package

The marker must survive the squash. A `!` that lives only in a commit you squash away is not in the
range the gate grades, so put it in the subject that lands on `main`.

**The heading is a `##` and names the release**, like `## From 0.48.2 to 0.49.0`. Both matter, and
neither is a style preference. Coverage is claimed by a heading, so a heading that names
no release claims every release and distinguishes none: `## Notes` with a sentence under it would
otherwise satisfy the rule. Naming the release also makes the section the one an operator upgrading
that release will search for. Use `###` freely for detail inside a section. Subsections belong to
their release rather than counting as separate coverage.

A section is written for the operator, not for the reviewer. It answers, in this order:

1. What keeps working with no action at all.
2. What does **not** migrate, and when that becomes visible. Name the log line if there is one.
3. The order to move components in for a split topology, and why that order.
4. What the outage window looks like, including what survives it.
5. What to snapshot before starting.
6. The commands, end to end.

**Where an answer was not measured, say so in the document rather than guessing.** An operator who
knows which half of a recommendation is reasoned and which is measured can plan around it; one who
finds out afterwards cannot.
