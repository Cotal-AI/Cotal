# HEALTH-1 discriminator — RESULT

Predictions were registered in commit `8333f0c5` BEFORE this run. Refutation conditions R1-R4 are
quoted from that commit, not restated from memory.

All timestamps are `date -u` read at the moment of the run, never derived.

## Runs

### Arm 1 — the INSTALLED artifact (`cotal-ai 0.16.0`, `/home/david/.local/bin/cotal`)

`cotal ps --space main --server nats://broker.cotal.ai:4222`, twice, exit code captured to a file
(not read from a pipe).

| Run | date -u (start) | rc | stderr |
|---|---|---|---|
| 1 | Fri Aug 14 11:53:42 AM UTC 2026 | **1** | `✗ no manager reachable (no responders: 'cotal.main.ctl.manager.local.UAHOMMSEVX67P4B7OIE54JJFIUMLI6XDNHRZ362WMN4UPNJYAVC6GOEQ')` |
| 2 | Fri Aug 14 11:53:44 AM UTC 2026 | **1** | `✗ no manager reachable (no responders: 'cotal.main.ctl.manager.local.UBC3XPP5FA6IBXD56V7JBRTGUCSTD65YG5YHAPB2HAGF2HH2STJPKERP')` |

Reproduced. Two distinct, never-repeating ids, ~2s apart, consistent with the reporter.

### Arm 2 — the REPO checkout (this worktree, `package.json` 0.0.0)

Same flags, same broker, same minute.

| Run | date -u (start) | rc | result |
|---|---|---|---|
| 1 | Fri Aug 14 11:55:42 AM UTC 2026 | **0** | lists managers `4ik6rb0e`, `bkp8vd8v`, `tak1gt6q`; 8 agents under `tak1gt6q` |
| 2 | Fri Aug 14 11:55:49 AM UTC 2026 | **0** | identical |

**The repo checkout does not reproduce HEALTH-1. It succeeds.** All three registered managers
ANSWERED the class scatter. `4ik6rb0e` and `bkp8vd8v` report `no agents`; `tak1gt6q` carries the 8
live agents. They are live-and-empty, not dead.

## Verdict against the pre-registered conditions

| # | Condition | Met? | Consequence |
|---|---|---|---|
| R1 | a failing id matches a roster manager id | **NO** — roster at 11:52Z held `local.UATRJAG…`, `local.UBGXP2JT…`, `local.UDJIWHE5…`; neither failing id is among them | (A) survives |
| R2 | two invocations produce the SAME failing id | **NO** — the two ids differ | (A) survives |
| R3 | the failing id is the CALLER'S OWN connection id | **YES — by construction, from the source of the exact artifact that produced it** | **(B) IS DEAD** |
| R4 | all distinct and none a manager's | yes, but recorded in advance as too weak to settle anything | not cited as proof |

### R3, established from the installed artifact's own source

1. `@cotal-ai/cli/dist/lib/control.js` `askManager` builds a `CotalEndpoint` with
   `card: { name: "cli", kind: "endpoint" }` — **no `actor` field** — then calls
   `ep.requestControl(tier, …)`.
2. `@cotal-ai/core/dist/endpoint.js:246` — `this.actor = opts.card.actor ?? this.connId`. With no
   card actor, **the endpoint's actor IS its own ephemeral NATS connection id.**
3. `@cotal-ai/core/dist/endpoint.js` `requestControl` —
   `const reqSubject = controlServiceSubject(this.space, service, this.owner, this.actor)`.
4. `@cotal-ai/core/dist/subjects.js:460-462` —
   `` `${spacePrefix(space)}.ctl.${routeToken(service)}.${ownerToken(owner)}.${ownerToken(actor)}` ``.

`DEV_OWNER = "local"`, so the subject is `cotal.main.ctl.manager.local.<the caller's own connId>`
— which is character-for-character the shape printed in both failures. **The never-repeating
`local.U…` in that error is the CLI's own connection, not any manager's.**

**HYPOTHESIS (A) IS CONFIRMED. HYPOTHESIS (B) IS DEAD.** A split manager queue is refuted twice
over: the id is caller-side, and independently all three managers answer.

### The one honest limit on R3, stated rather than buried

R3 as written asked for an EMPIRICAL match between the failing id and the caller's connection id
captured in the same run. What I have is a **mechanical** proof from the artifact's source that the
subject can be built from nothing else. That is stronger about the mechanism and weaker about the
observation, and the two are not interchangeable. The empirical arm — read the id out of an
ephemeral broker's `connz` for the very connection that then fails — is NOT yet run. Recorded as
unrun. It does not change the verdict, because (B) is already refuted independently by all three
managers answering in arm 2.

## What actually causes HEALTH-1 — and it is NOT id selection

The failing subject rides the **`ctl` rail**. This repo's control client states plainly that
`ctl` is gone: *"since 1d the manager's ONLY control door (the `ctl` tiers are deleted)"*
(`implementations/cli/src/lib/control.ts`). The live managers serve the **ep rails**, which is why
arm 2 succeeds against the same brokers in the same minute.

So the chain is:

1. Installed 0.16.0 publishes a control request on `ctl.manager.<its own principal>`. **This part is
   correct by design** — the manager subscribes across caller principals and the broker authorizes
   per-caller publish (`subjects.js:463`: *"The manager subscribes to ALL three"*).
2. No live manager subscribes to the `ctl` rail any more.
3. The broker answers no-responders instantly. **That is why it is 2.3s and not a timeout** — the
   reporter's instinct was right and the reason is now measured.
4. The error prints the subject, which contains the CALLER'S OWN ephemeral id, under the words
   "no manager reachable" — so an operator reads a fresh random id as a named absent manager.

**HEALTH-1 is version skew between the installed CLI and the live managers. It belongs to the
release-artifact gap (E2E blocker 1), which I was told explicitly is not this lane's and is not
fixable by any lane.** I am NOT scoping the skew in.

## The residue that IS this lane's

The defect of the *surface* is real and is exactly the class: the command received the fact
"nobody is listening on the rail I speak" and reported the claim "no manager reachable", naming an
id that is its own. It degraded its input and did not degrade its claim, and it offered no recovery
action.

In the current tree that specific text is structurally gone (the `ctl` client is deleted; the ep
path's failure reads `no manager reachable on the ep rails (…)` and names no caller id). **So the
question this lane must answer is not "fix HEALTH-1" but "does the CURRENT code degrade its claim
honestly when it genuinely cannot reach a manager?"** — which is testable on an ephemeral broker
with no manager, and is where the cell goes.

## Collateral measurements from the same runs

- **HEALTH-3 REPRODUCES ON THE REPO CHECKOUT.** `pnpm cotal status --space main --server …` at
  11:56:17Z, rc=0: `connection ok`, `roster 18 endpoints`, 16 channels listed — and the last line
  `membership feed  no heartbeat`. Everything above it is green and confident; the degraded input
  is a dim trailing caveat. **This one is ours and it is the cleanest specimen of the class.**
- A contradiction between two surfaces on this box, reported and NOT patched: the status card's
  Machine block reads `cotal-ai v0.17.0` while `cotal --version` on the same box prints
  `cotal-ai 0.16.0`. I am not asserting which is right or whose lane it is; it needs an owner.
- The same status card recommends `cotal setup` twice (`Claude skills stale · cotal setup`,
  `Skills (.agents) 1/1 out of date · cotal setup`). fm-orchestrator measured `cotal setup` to
  perform announced WRITES. A read-only status card routing an operator to a writing command is
  adjacent to HEALTH-2 and is recorded here rather than acted on.
