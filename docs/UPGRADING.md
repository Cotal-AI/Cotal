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
  been required alongside `--creds` since 0.45.0, and the pairing rule did not change in this
  release. A scripted external join that worked under 0.48.2 works unchanged.

### The one thing that does not migrate

**A credential minted before 0.49.0 cannot be renewed.** Managed agent credentials carry a
24-hour lifetime and the manager re-signs them at half life. When the manager reaches a credential
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

**Respawn the managed agents deliberately, as the last step of the upgrade.** A respawn mints a
fresh credential as an issuance and the agent renews normally from then on. Doing it as a planned
step takes one pass over the fleet; not doing it means meeting the same work spread over the
following day, discovered one agent at a time.

An external peer holding a static credential is the same case. Re-mint it at a time you choose.

### How to read the boot log

A 0.49.0 manager starting over an existing space may print lines like:

```
verified evicted: local.U…
already verified (durable): local.U…
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
  connection with `authentication error - Nkey`, continuously. `cotal ps` reports zero agents while
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

- Agent **processes keep running** across the whole window. They are not killed by either step.
- The **manager's view** of them is lost while the two sides disagree, so `cotal ps` reports zero
  and control commands do not reach seats.
- **Messages are not delivered** while the mesh is down.
- The window is as long as it takes to restart the second component, plus the manager's own start.
  It is minutes, not hours, provided you do not stop between the steps.
- **Nothing self-heals if you stop halfway.** The refusal is continuous until both sides match.

### Snapshot this before you start

Take these while the deployment is still on 0.48.2:

- **A filesystem or volume snapshot of both containers**, if your platform offers one. This is the
  only rollback that covers every case, and it is what the reporting deployment used.
- **`cotal backup`**, for the durable space state.
- **The trust records and credential directory** under `.cotal/auth` on the manager host, including
  the per-space material directory. These are what a re-mint would otherwise have to replace.
- **A copy of the channel registry**, so you can verify it came back rather than assuming it did:
  `cotal channels` before and after.
- **The output of `cotal ps`**, so you know how many seats you expect to see afterwards and can tell
  a lost view from a lost agent.

### The upgrade end to end

```bash
# 0. on 0.48.2, still running: snapshot, and record what you expect to see afterwards
cotal backup
cotal channels > channels.before
cotal ps > ps.before

# 1. manager host: stop the supervisor, install 0.49.0, start it again
cotal down manager
npm install -g cotal-ai@0.49.0
cotal supervise --space <space> --server nats://<broker>:4222

# 2. broker host: stop the stack, install 0.49.0, start it again
cotal down
npm install -g cotal-ai@0.49.0
cotal up --detach --host 0.0.0.0 --space <space>

# 3. verify the mesh is whole again before touching the fleet
cotal ps            # compare against ps.before
cotal channels      # compare against channels.before

# 4. the step that is easy to skip: respawn the managed agents so their
#    credentials are re-minted as issuances and can renew
```

Between steps 1 and 2 the mesh is down. That is the window.

## Adding a section for a future release

**Every changeset marked breaking adds a section to this page.** A release that changes what an
operator must do, in what order, or what stops working, is not finished until the section exists.
This is enforced: a repository check reds when a breaking change lands with no matching section
here, so the rule cannot decay into a convention nobody remembers.

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
