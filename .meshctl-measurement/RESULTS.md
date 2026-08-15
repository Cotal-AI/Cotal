# Measurement: agent-driven mesh connection control

> **⚠️ POST-REWRITE PROVENANCE, `Sat Aug 15 12:30:46 AM UTC 2026`.** This lane's history was
> rewritten by fm-orchestrator (`c076eb41..d591bb80`, 38 commits; tip `d591bb80` → `305f04de`).
> **Every run-stamp sha in this file was re-pointed to the rewritten graph in one pass** — the
> mapping was reconstructed from the two graphs (the `.git/filter-branch/map/` this lane was told
> to use does not exist on this box) and validated with a shift-by-one control that mismatched
> 37/37, so the aligned 0/38 means something.
>
> **THE SHAS ARE FIXED. THE COUNTS ARE NOT RE-RUN.** Old and new tips carry a byte-identical tree,
> which makes "the suite still passes" an **inference**, and this file does not cite inferences.
> Until the suites below are re-driven against ephemeral brokers, treat every count here as
> **stamped, not confirmed**. Re-running is broker-backed and this lane does not hold a window.
>
> **PARTIALLY DISCHARGED, `Sat Aug 15 01:09:22 AM UTC 2026` → `01:10:57 AM UTC`, at `fe279b94`.**
> The window opened and the three **committed** suites were re-driven. Their counts are now
> **confirmed, not stamped** — logs in `runs/`, cell-by-cell roll-call in §"Re-drive at fe279b94".
> **The m-probes in this directory were NOT re-driven in that pass and remain stamped.** Which
> rows moved is stated in that section; do not read one discharged suite as discharging the file.

Base `7cc74f50` (measured at `1aab1389`; delta since is release/docs only). All results DRIVEN against ephemeral loopback brokers. Each probe asserts its
target is not the live broker as its first action. Refutation conditions are stated in each probe's
header **before** any result.

**On controls, stated exactly rather than as a blanket claim.** An earlier draft of this line said
"each denial has an inverse control through the same path". That was too strong: **`F3b` has none**
(§5), and it is now marked as weak evidence rather than left inside a general assurance. Every other
denial cited here does have one. A blanket claim about evidence quality is itself a claim that needs
to be true of every row, and this one was not.

Probes must run from the main checkout (they import per-package `node_modules`); they are kept
here as the record. **They do NOT run from this directory — their imports are package-relative, so
each must be copied back to its package home first. The Reproduction block below gives the exact
copy step; an earlier version gave commands naming files that were not at those paths.**

**COUNTS IN THIS FILE DISTINGUISH ASSERTIONS FROM RECORDED OBSERVATIONS.** A probe answering an
*open question* records what it observed rather than asserting an answer it was trying to discover.
Those cells are real evidence of what was seen and are **not** evidence that a property holds, so
they are no longer counted in a pass total. Cite `§7.2` as **7 asserted + 4 recorded** and `§7.2(b)`
as **3 asserted + 2 recorded** — never as `11/11` or `5/5`, which is how they were first reported
here. The probes now print that caveat themselves.

## Findings

### 1. `cotal_leave` will leave an agent's only channel — the description says it cannot
The tool description (`extensions/connector-core/src/tool-specs.ts:503`) says "You can't leave your
only channel." `MeshAgent.leaveChannel`'s jsdoc (`agent.ts:1073`) repeats it: "(refuses to leave the
last one)". No such guard exists. `CotalEndpoint.leaveChannel`
(`packages/core/src/endpoint.ts:1598-1622`) tests only `!this.channels.includes(channel)` and then
splices unconditionally.

Driven through the real entry point (`cotalToolSpecs(...).run(...)`, what `registerCotalTools`
dispatches an MCP call to — `tools.ts:29`):

| call | result | joinedChannels |
| --- | --- | --- |
| `leave(ops)` — non-last, **inverse control** | `isError=false` "Left #ops." | `["general","ops"]` → `["general"]` |
| `leave(general)` — last | `isError=false` "Left #general." | `["general"]` → `[]` |

The control succeeded, so the arms could differ: this is not a broken probe.

### 2. The ghost already exists on main, without this feature
Measured with an **independent observer peer** — a self-view roster is not evidence of what a
supervisor sees.

| stage | observer-B's view of subject-a |
| --- | --- |
| baseline | `idle` |
| after subject-a leaves its ONLY channel | `idle` — unchanged |
| after a real `stop()` — **inverse control** | `offline` |

The control holds (a real departure *is* visible), so the ghost is specific to self-silencing and
not a generally stale roster. An agent can already make itself silent on every channel while
remaining indistinguishable from a healthy idle peer.

### 3. Leaving every channel is not a disconnect
A DM sent to the fully-silenced agent was still delivered and read back out of its inbox. The DM
plane is untouched by channel membership, so a channel-silenced agent has **not** made itself
unreachable to whoever supervises it.

### 4. The fence is the broker; a credential is space-scoped *and* issuer-scoped
Broker AB trusts two space accounts under one operator; broker C has a foreign operator. 9/9.

| check | result |
| --- | --- |
| C1 agent-A cred → own in-ACL channel, space A (**control**) | ALLOWED |
| C2 agent-A cred → broker that trusts its account (**control**) | CONNECTED |
| F1a agent-A cred → space B `chat.*.general` | DENIED |
| F1b agent-A cred → space B whole-space wildcard | DENIED |
| F1c agent-A cred → its own space's firehose `<space>.>` | DENIED |
| F1d agent-A cred → out-of-ACL channel in its own space | DENIED |
| F2 agent-A cred → foreign-operator broker C | CONNECT REFUSED |

A self-directed re-target that re-presents the credential the agent already holds reaches
**nothing new**: another space on the same broker denies every subject, and another broker refuses
the connection outright.

### 5. The authority is the mint, not the connect
| check | result |
| --- | --- |
| F3 a cred minted from the same `SpaceAuth` with a **self-chosen** ACL → `chat.*.secret` (the exact subject denied at F1d) | ALLOWED |
| F3b a `provisioner` cred → the space firehose | DENIED — least-privilege genuinely holds |

**F3b HAS NO POSITIVE ARM AND IS THEREFORE WEAK EVIDENCE — withdrawn from load-bearing use.** Every
other denial in this file is paired with a control that succeeds through the same path; F3b is not.
Nothing in the probe shows that the *same* `provisioner` credential can do anything at all on that
broker, so "DENIED" is equally explained by a credential that was never usable — a broken probe
looks exactly like a working fence. The `provisioner` cred is exercised successfully elsewhere in the
fixtures (`setupSpaceStreams` and `provisionAgent` both run on it), which is suggestive and is **not
the same probe**, so it does not repair this cell. The claim "there is no god-role to grab" rests on
F1a-d and F2, which do have controls. **A denial without an inverse control is not a control.**

Same broker, same subject, same probe as F1d; only the mint differs. The ACL is decided at mint
time, so whoever can read the space trust material can issue any ACL.

**CORRECTED (adversarial review):** this probe builds its `SpaceAuth` **in memory** and never opens
`auth.json`. "The ACL is chosen at mint time" is measured **[M]**; "an agent can read the on-disk
trust material" is a **[R]**. The first draft labelled the combination measured.

**And the rule this finding produced was too weak.** "Never reach the mint path" is a ban on
function names, and three paths obey its letter while still obtaining freshly minted authority
(user-mode `bearerCmd` re-reads the current ledger per connect; the manager re-mints static creds;
`cotal_spawn` mints indirectly). See DESIGN §1 for the replacement invariant, which is about grant
SCOPE rather than function names.

### 6. `cotal_reconnect` cannot re-target, and a leave survives it
`connectAndBind` (`endpoint.ts:821-855`) dials `this.servers` / `this.space`, both pinned at
construction, so no re-target primitive hides in today's surface. `startConsumers` re-subscribes
from `this.channels` — the mutated live array — so a leave is preserved across a reconnect
in-process, but **not** across a process restart, where config re-seeds.

`connId` is `private readonly` (`endpoint.ts:445`), assigned once. Reconnect is identity-preserving;
the reply inbox namespace survives, though a reply arriving inside the rebuild's null window has no
subscriber. A **re-target cannot be done in place**: space, servers, creds and `connId` are all
constructor-pinned, so re-targeting builds a new endpoint.

**CORRECTED (adversarial review) — "and therefore a new mesh identity" is FALSE.** Wire identity is
the `owner.actor` principal, distinct from `connId`, and it derives from the CREDENTIAL
(`endpoint.ts:493-534`). A new endpoint built from the same credential carries the same identity.
The inference "readonly `connId` ⇒ new identity" does not follow — `connId` is the inbox nonce. It
is the credential that decides, so a re-target to a different mesh differs in identity because it
uses a different credential.

### 7. The client-side ACL check is defence-in-depth under auth, and the only fence in open mode
The comment at `tool-specs.ts:470-471` claims "Auth mode also enforces this server-side; this is the
friendly client gate." Accurate under auth — F1d proves the broker denies out-of-ACL subscribe
natively. Under open mode, driven:

| call | result |
| --- | --- |
| `join(general)` in-ACL (**control**) | ok |
| `join(secret)` out-of-ACL, through the tool | `isError=true` "outside your read ACL" |
| `agent.joinChannel("secret")` beneath the tool | `{"joined":true}` → `["general","secret"]` |

Open mode has no broker ACLs by construction, so this is not a defect — but it is the wrong layer
at which to place a new authority decision.

### 8. Two supervisory views, by design
`AgentHandle` (`packages/core/src/runtime.ts:29`) is documented as the manager's handle "to
*control* the process (the mesh observes its presence separately)", and manager liveness reads
`handle.status()` — an OS process state, not a mesh connection state. A self-disconnect therefore
diverges the two views: the manager still reads "running" while the mesh view changes (or, per
finding 2, fails to change at all).

## Verb inventory
Exactly four verbs change an agent's connection, membership, or subscriptions today:
`cotal_reconnect`, `cotal_join`, `cotal_leave`, `cotal_channel_mode`. There is no self-connect,
disconnect, or re-target — the feature is net-new surface.

## Connect branches (READ, not driven)
`packages/workspace/src/connect.ts` returns four different shapes:

| branch | returns |
| --- | --- |
| `--creds` raw off-registry (`:222-242`) | no `epCaller`, no `auth`, no `root`, `tls:false` |
| open raw, `--server` + unregistered `--space` (`:247-264`) | no credential at all |
| user/bearer (`:370-410`) | bearer + sentinel + `userAuth` + `root` + `epCaller` from the bearer's own JWT principal |
| registered static (`:295-319`) | minted creds; `epCaller` only for instrument roles |

The **user/bearer** path is the one carrying account authority: its caller triple derives from a
user account's ledger lifecycle claim, and the code calls it "the control surface; ledger scope is
the grant" (`:271-273`). The `--creds` path looks the most privileged and is the least
account-bound.

## 9. In-flight replies and the presence lease **[M — M5]**

`requestControl` issues `nc.request(..., {noMux, reply})`, so the reply subject AND the timeout timer
both live on the connection. Rebuilt mid-flight, the call **never settled inside 20s despite its own
5000ms deadline**; the uninterrupted control resolved at 600ms through the identical path. Fixed —
see `packages/core/smoke/request-strand.smoke.ts`.

A graceful `stop()` **marks** the presence entry `offline` rather than deleting it, best-effort
inside a try/catch (`endpoint.ts:1123-1153`). So a crash leaves the last status standing until TTL.

## 10. Durable membership under a self-disconnect **[M — M6, 4/4]**

A self-disconnect leaves the Plane-3 membership OPEN; only an explicit leave closes it. Controls:
the backstop delivers while the agent is up (C1); a post after an explicit `durableLeave` is not
delivered (C2). **Scope: this covers ONE directly-created membership and a direct privileged
tombstone. It does not cover multi-membership cleanup, partial failure, concurrent reopen, or
re-target through the agent's own credential.** See DESIGN §7.2 for the saga this does not close.

## Not measured

**ADDED AFTER AN ADVERSARIAL AUDIT OF THIS LIST ITSELF.** `rev2-meshctl-evidence` was asked to check
this section for *omissions* rather than for what it contained, on the principle that **an
honest-looking list missing an item is the most misleading artifact in the tree** — it reads as
complete. It found the following, and they are recorded here in its framing rather than mine:

- **NO PROBE OR SUITE EVER SENDS AN MCP REQUEST.** Every one of them calls `spec.run(...)` directly.
  The real dispatch path — `registerCotalTools` wrapping `spec.run` (`extensions/connector-core/src/tools.ts:23-36`)
  — **is never exercised, and no host is involved.** Direct `run` proves the handler is reachable in
  a test; it does **not** prove a real MCP caller reaches it. **This lane has repeatedly described
  its probes as driving "the real entry point". That is true relative to internal helpers and FALSE
  relative to an actual MCP host**, and both halves belong in the same sentence.
- **No AUTHED session drives the new verbs.** The connector happy path uses an **open-mode**
  hand-built fixture; the auth and user configs appear only in the visibility arms (G1-G6). So the
  verbs are measured end-to-end **only in the mode with no credential and no broker ACL**.
- **No tool-path proof that `cotal_disconnect` preserves durable membership**, nor that
  `cotal_connect` replays it. M6 uses `stop()` plus privileged direct membership calls; the connector
  suite never asserts that off-mesh channel traffic replays after the return.
- **Tool-level refusals are unmeasured for most of the vocabulary**: `transition-unconfirmed`,
  `transition-in-progress`, `shutting-down`, `in-flight-request`, and the broker/auth/expired/source
  failures. The connector suite covers `not-connected` and `already-connected` only; the rest are
  driven at the core API, which is a different caller.
- **A failing `reassertPresence()` is unmeasured on both branches it now reports** — the refused
  disconnect and the successful connect. See MX5: that fix is unproven by mutation.
- **§7.2(b) does not assert the exact `+5 / +0`** (C2 asserts only `closed < open`), **does not
  observe presence expiry** (it is inferred from a sleep), and **drives no failed close or re-target**
  — it abandons an already-open membership, which is a narrower mechanism than the section it supports.
- **§7.2's caller-path claim is not driven through `cotal_join`** — the probe calls
  `CotalEndpoint.joinChannel` directly — and the replay-off arm never attempts a re-join at all.
- **M5 drives only `requestControl`**, twice. `requestDelivery`, `requestDeliveryAdmin` and the spawn
  rail are untouched, and the "permanent" hang is an observation bounded at 20s, not a proof of
  permanence. The correction that "spawn rejects rather than strands" is a **[R]**.

- The user/bearer branch driven live (needs the auth service and a login). The connect-branch table
  above is a code read, not a measurement — the weakest claim here.
- Leases and claims held by an agent at disconnect. (In-flight *replies* ARE now measured — §9.)
- Multi-membership close, partial-close failure, and concurrent reopen during a close scan (§7.2 of
  the design). M6 covers the single-membership case only. **The single-membership GAP is now
  measured** — see the §7.2 probe below — but the multi-membership and partial-failure cases are not.
- **The other half of a partial close**: channels that FAIL to close stay open on an abandoned mesh
  and keep accruing. No probe touches it.
- A confirmed causal presence transition — no probe drives one; M4 drives today's best-effort stop.
- **`F3b` has no positive arm** (above), so "provisioner is least-privilege" is weaker than the other
  fence cells.
- **The creds-SOURCE renewal arm is not reachable through `cotalToolSpecs`** — `MeshAgent` passes
  static creds bytes, and the user-mode bearer source exchanges over local auth-service HTTP rather
  than NATS. The renewal cells prove the ENDPOINT contract and say nothing about the tool path.
  (Narrowing volunteered by `rev2-meshctl-authority` against its own broader claim, and held to.)
- **A drain that rejects** is a state the connector cannot construct; it is driven with an injected
  fault at the core API.
- ~~**and an in-flight credential fetch crossing a disconnect … that exact race is undriven**~~ —
  **WITHDRAWN, AND THIS ONE WAS STALE IN THE DIRECTION THAT FLATTERED ME.** ARM 3b drives exactly
  that race (hold a source call open, disconnect, release) and **MX4 killed the cell** with two
  authenticated dials at the broker. Leaving it here made the not-measured list look more scrupulous
  than the tree actually was, which is the worst direction for *this* list to drift: an entry that
  overstates a gap is a smaller sin than an omission, but it is the same failure of upkeep, and it
  costs the list its authority either way. Caught by `rev2-meshctl-evidence`.
- ~~**The three arms of `connection-lifecycle.smoke.ts` share one fixture**~~ — **FIXED and
  demonstrated, not merely asserted.** Each arm now declares a named entry precondition; ARM 1 builds
  its own subject instead of inheriting ARM 2's; ARM 3 restarts the broker. A failed precondition
  records that arm's cells **VOID — not evaluated** rather than failed. Re-running the *same* MX2
  mutant now reddens ARM 2's four named cells while **ARM 1 stays 7/7 green**, so "green elsewhere"
  is a measured property rather than an assumption. **The first attempt at this fix was refuted by
  its own experiment** (ARM 3's precondition failed, `current: 2`, and 13 cells voided) — the second
  pass fixed the cause. Full record in `MUTATION-LIFECYCLE.md` § MX2-R.
- **What is still NOT claimed about ARM 3:** under MX2 it is *fairly run*, not *unaffected*. It calls
  the mutated `disconnect()` itself, so `D3c` reddens legitimately. Its green precondition is what
  makes that red attributable to `c` alone rather than to a predecessor — but "unaffected by a
  mutation in another arm" is proven for ARM 1 only.

### What HAS been run, named as suites
**No repo-wide suite has been run and no gate has been released to this lane.** Scoped only:
- Probes: M1 verb drive, M2 open-mode gate-bypass, M3 broker fence (9), M4 observer ghost,
  M5 lease/in-flight, M6 durable membership (4/4), **§7.2 gap (7 asserted + 4 recorded)**.
- Committed suites, **each named with the tip it was last RUN at, not the tip it was last edited at**:
  `packages/core/smoke/connection-lifecycle.smoke.ts` **39/39 at `e15b6e36`** (re-run today, rc=0 captured),
  `extensions/connector-core/smoke/connection-control.smoke.ts` **45 passed / 0 failed / 0 VOID at
  `a89dc6e4`** (run `Fri Aug 14 10:57:18 PM UTC 2026`, ephemeral loopback broker; **counted in three
  columns, not one — passes, failures and VOIDs are never summed, and the run additionally printed
  2 RECORDED observations which are not passes**; E18 was re-asserted and re-run at `10f19a6a`
  after it SURVIVED its mutation — see below),
  `.meshctl-measurement/meshctl-m10-twoviews.smoke.ts` **5 passed / 0 failed at `dd74dd2b`**
  (run `Fri Aug 14 11:10:05 PM UTC 2026`; 2 RECORDED observations, and **its headline is not usable
  — the fixture's "long-lived" view lived ~100s against a hypothesis about a session hours old**),
  `packages/core/smoke/request-strand.smoke.ts` **9/9 at `ffc18c46`** (was 7/7 before ARM 3 was added).
- Mutations, on named cells with broker-side non-equivalence: **MX1/MX2/MX4 killed; MX6, MX7b, MX8,
  MX8c, MX9, MX10, MX10b, MX11, MX12b killed; MX12 VOID (mutant never reached — the Plane-3 durable
  path, not the live one); MX8b REFUTED its own prediction and is kept as the reason MX8c exists;
  MX7a superseded as too blunt; MX3a and MX5 survived, as predicted.** Full ledger:
  `.meshctl-measurement/MX7-PREDICTION.md`.
  **MX13 SURVIVED and is the most instructive one in the ledger.** Target: E18, "a credential
  re-pointed at another space is refused." Mutant: widen the grant's space segment to `*`, i.e.
  **delete the fence the cell claims to measure.** The cell stayed **green** — the foreign space has
  no streams, so the publish failed anyway with `jetstream is not enabled` instead of a permissions
  violation. **An unrelated failure stood in for the one that had been removed.** Re-asserted to
  require a permissions refusal *naming the foreign subject*; on the same mutant it goes red alone
  (44/1/0) while E12/E14/E15/E17 hold. *A refusal is evidence of a fence only if the cell names
  WHICH fence refused.*

**⚠️ AND THE LEAK SCANNER'S VERDICT WAS UNINFORMATIVE FOR HOURS.** Every `LEAK` result quoted from
the 172-term list was vacuous: **44 of those terms are ordinary public strings** (they occur in
`origin/main`), so *every* scan of *any* file returned LEAK. **The scanner already refused a guard
that cannot FAIL; it had no guard against a verdict that cannot be CLEAN.** Fixed at the method
(refusal 96, `leakscan.sh`) on a definitional test — *a term that already exists in public upstream
content is not a secret* — driven in three arms so a guard that passed by disabling detection would
have been caught. **The audit's standing is unchanged (the tree was and is clean against the
canonical 12); what changed is that a LEAK verdict now carries information.**

**⚠️ AND THE DRIFT THIS SECTION WAS WRITTEN TO PREVENT RECURRED IN THIS SECTION.** The line above read
`21/21 at 7dae9115` while the suite had grown to 39 cells and moved 6 commits — the *same* failure,
in the *same* list, immediately below the paragraph explaining it. **Writing down the lesson did not
stop me repeating it; re-deriving the number from a run did.** The count is only trustworthy on the
run that produced it, and the fix is to stamp it at write time from a log, never from memory of the
last edit.

**Why the first two lines now carry different hashes.** This list previously stamped every suite with
`ffc18c46` and reported the lifecycle suite as **20/20**, then **27/27**, while the suite had grown to
**32** cells. Nothing was falsified — the counts were simply carried forward from the last time the
line was *written* rather than the last time the suite was *run*, and a single shared hash hid which
was which. **The lifecycle number is now one I re-derived by running it; the other two are not, and
they say so.** A suite's result belongs to the commit it was executed against.

**The earlier draft of this list said "no repo suite was run" and then cited a committed suite's
result in the same bullet, which reads as a contradiction.** It was not one — a committed suite run
on its own is not a repo-wide run — but the two claims needed separating rather than defending, so
they now sit in different sections.

## Reproduction

~~The probes import core via a relative path, so they exercise **the tree they sit in**.~~
**STRUCK — THIS WAS WRONG FOR FIVE OF NINE PROBES, AND IT WAS THE SENTENCE THAT WOULD HAVE TOLD A
READER THEY WERE SAFE.** Corrected `Fri Aug 14 08:53:21 PM UTC 2026`. Measured, per probe, from the
import statements rather than from memory:

| Leg | How it reaches core | Exposed to `dist/`? |
| --- | --- | --- |
| `connection-lifecycle.smoke.ts` | `../src/index.js` | **No** |
| `meshctl-72-gap`, `meshctl-72b-leak` | `../packages/core/src/index.js` | **No** |
| `meshctl-m3-fence`, `meshctl-m6-durable` | no core import — raw NATS **at the broker** | **No** |
| `meshctl-m1-probe`, `meshctl-m2-gate`, `meshctl-m4-probe` | relative connector src, but `agent.ts:29` imports `@cotal-ai/core` | **YES, transitively** |
| `meshctl-m5-lease`, `meshctl-m5-verify` | `@cotal-ai/core` directly **and** transitively | **YES** |
| `connection-control.smoke.ts` | `@cotal-ai/core` | **YES** (now refuses on a stale build) |

The transitive path is the one that hid: a probe can import nothing but relative connector source and
still execute core from `dist/`, because the connector itself crosses the specifier. **"This probe's
own imports are relative" is not an answer to the question** — the endpoint under test still came
from a build.

Run them from a checkout with `node_modules` reachable (this program never runs `pnpm install`).

**Trap worth knowing, MEASURED on this box rather than reasoned about.** It has two faces and they
are usually confused for each other:

1. **Resolution.** This worktree's ROOT `node_modules` is a symlink to the principal checkout, and
   `node_modules/@cotal-ai/core` resolves to the PRINCIPAL's `packages/core`. A real, non-symlinked
   `extensions/connector-core/node_modules/` stops resolution before it walks up that far, which is
   why the connector suite is clear:
   ```
   $ cd extensions/connector-core && node -e 'console.log(await import.meta.resolve("@cotal-ai/core"))'
   file:///home/david/Cotal-wt-fm-meshctl/packages/core/dist/index.js
   ```
   **Resolve the path; do not infer it from "am I in a worktree".** Anything resolving
   `@cotal-ai/core` from the worktree ROOT still lands in the principal checkout.
2. **Built output.** `@cotal-ai/core`'s `main` is `./dist/index.js`. **Mutating `packages/core/src`
   without rebuilding `dist` produces a NO-OP mutant, and a no-op mutant is byte-identical to a
   survivor.** That cost four runs here, recorded as VOID rather than banked as survivals. Suites
   importing `../src/index.js` relatively (the lifecycle, request-strand and §7.2 probes) do not have
   this face at all; ~~the connector suite does~~ **the connector suite AND the five m-probes above
   do** (struck for the same reason as the heading: it named one leg where there are six), and it
   needs `tsc -p packages/core` before every run.

   **THE CONNECTOR SUITE NO LONGER RELIES ON THAT DISCIPLINE.** It refuses to run when
   `packages/core/dist/endpoint.js` is older than any `packages/core/src/*.ts`, prints
   `[provenance] core dist built at <iso>` when it proceeds, and both arms were driven: fresh dist →
   30/0/0 rc=0; `touch packages/core/src/endpoint.ts` → `REFUSING TO RUN … stale vs: endpoint.ts`
   rc=1, before any broker starts. A green with no build provenance is **UNGRADED, not passing**, and
   a rule that has to be remembered before every run is not a rule.

   **THE FIVE M-PROBES HAVE BEEN RE-DERIVED WITH PROVENANCE** rather than left ungraded. Core built
   at `2026-08-14 22:50:53Z`, verified newer than every `packages/core/src/*.ts` at run time; each
   probe copied to its package home per the block below and re-run `Fri Aug 14 08:53:21 PM UTC 2026`:
   - `m1` — VERDICT-A `CLAIM FALSE` (the only-channel guard does not exist), VERDICT-B leave
     survives reconnect. **Identical to the record.**
   - `m2` — `CONFIRMED`: in open mode the tool's ACL check is the only fence. **Identical.**
   - `m4` — Q1 `GHOST CONFIRMED`, Q2 `DM STILL DELIVERED`, Q3 control holds. **Identical.**
   - `m5-verify` — Q1 `CONFIRMED` (a rebuild orphans the reply), Q2 `MARKED not deleted`. **Identical.**

   All five reproduce exactly, so the findings stand **and now stand on a stated build** rather than
   on the assumption that whichever `dist` was present happened to match. Re-derivation was the point:
   these results were not wrong, they were **unestablished**, and those are different words.

   **AND THEN THE OTHER FOUR, so the whole lane is on one footing** (`Fri Aug 14 08:55:07 PM UTC 2026`,
   same build). I had first reported `m5-lease`, `m3-fence` and `m6-durable` as *not* re-run — judged
   clean by reading imports. **That is an argument, not a measurement, and this lane does not bank
   arguments**, so they were driven too:
   - `m5-lease` — Q1 `CONFIRMED`, Q2 `MARKED not deleted`. **Identical.**
   - `m3-fence` — **9 passed, 0 failed**, including F2 (a foreign broker refuses the cred) and F3
     (a self-chosen ACL at mint time reaches what F1d denied). **Identical.**
   - `m6-durable` — **4 passed, 0 failed**: a self-disconnect leaves the durable membership OPEN.
     **Identical.**

   **Every leg on this lane is now re-derived against a build verified newer than every core source
   file, with the build time recorded.** Nine of nine. Nothing here rests on "whatever `dist` was
   lying around when it ran."

Neither is fixed by an install, and this program never runs one.

```
# ⚠️ THE M-PROBES DO NOT RUN WHERE THEY SIT. Copy each one to its package home FIRST.
# These files were run from the package directories and then collected into
# `.meshctl-measurement/` as the record. Their imports are package-relative
# (`./src/index.js`, `./src/agent.js`), so from here they resolve to nothing. The commands
# below used to name `packages/core/meshctl-m3-fence.smoke.ts` — a path with no file at it.
# Found by adversarial review; the runs were real, the RECORD could not re-derive them.

# core probes — `./src/index.js` + `./smoke/_free-port.js` ⇒ home is packages/core/
for f in meshctl-m3-fence.smoke.ts meshctl-m6-durable.smoke.ts meshctl-m5-lease.mts meshctl-m5-verify.mts; do
  cp .meshctl-measurement/$f packages/core/$f
done
node_modules/.bin/tsx packages/core/meshctl-m3-fence.smoke.ts
node_modules/.bin/tsx packages/core/meshctl-m5-lease.mts
node_modules/.bin/tsx packages/core/meshctl-m5-verify.mts
node_modules/.bin/tsx packages/core/meshctl-m6-durable.smoke.ts

# connector probes — `./src/agent.js` ⇒ home is extensions/connector-core/
for f in meshctl-m1-probe.mts meshctl-m2-gate.mts meshctl-m4-probe.mts; do
  cp .meshctl-measurement/$f extensions/connector-core/$f
done
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m1-probe.mts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m2-gate.mts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m4-probe.mts
# then delete the copies — they are untracked and must not be committed twice

# these two DO run where they sit (repo-root-relative imports), and need no copy:
node_modules/.bin/tsx .meshctl-measurement/meshctl-72-gap.smoke.ts
node_modules/.bin/tsx .meshctl-measurement/meshctl-72b-leak.smoke.ts
# committed suites, which live in their real homes and always ran there:
node_modules/.bin/tsx packages/core/smoke/request-strand.smoke.ts
node_modules/.bin/tsx packages/core/smoke/connection-lifecycle.smoke.ts
```

## Correction: F9's blast radius (recorded, because it was overstated)

I reported that `cotal_reconnect` while `cotal_spawn` is in flight hangs the spawn forever, and it
was escalated on that basis. **That is wrong.** `cotal_spawn` goes through `managerInvoke` →
`invokeService` (`agent.ts:758-794`) — the **ep rail** — which uses `nc.subscribe`/`nc.publish` raced
against a plain `setTimeout` (`endpoint-invoke.ts:97-131`). A Node timer is not connection-scoped, so
an ep-rail call **rejects with `deadline-exceeded` rather than stranding**.

The defect is real and measured for the three `nc.request` sites (`requestControl`,
`requestDelivery`, `requestDeliveryAdmin`) and those are what M5 drove. **The spawn impact was an
inference I did not test and it does not hold.** The fix stands on the measured sites; the severity
I attached to it did not.

## Re-drive at `fe279b94` — the committed suites, confirmed rather than stamped

Broker window held by this lane; no other lane running broker-backed suites against the box.
Wall clock read from `date -u` **at the moment of each run**, not derived: start
`Sat Aug 15 01:09:22 AM UTC 2026`, last suite ended `01:10:57 AM UTC 2026`. Tree `fe279b94`, clean
at run time. Node `v22.23.2`, `nats-server v2.12.1`.

**Invoked `node_modules/.bin/tsx` directly — never through `pnpm`.** In a worktree `pnpm` tries to
remove the symlinked `node_modules`, and a lane tonight took `EXIT=1` with **zero cells run** from
exactly that, which reads identically to a mutation kill if you grade on the exit code alone.
**The cell count is what separates a mutant that was caught from a suite that never asked**, so
each suite below is roll-called **by cell name** from its own log, not summarised by a total.

| suite | exit | cells green | red | VOID |
| --- | --- | --- | --- | --- |
| `extensions/connector-core/smoke/connection-control.smoke.ts` | `0` | **45** | 0 | 0 |
| `packages/core/smoke/connection-lifecycle.smoke.ts` | `0` | **39** | 0 | 0 |
| `packages/core/smoke/request-strand.smoke.ts` | `0` | **9** | 0 | 0 |

93 named cells, 0 red, **0 VOID** — no cell was skipped behind a contaminated fixture, which is the
failure mode `armCheck` exists to make visible. Full roll-call: `runs/*.txt`, committed here because
`/tmp` is volatile by policy and the commit is the authoritative copy. **The extension is `.txt` and
that is deliberate:** these were written as `.log`, and `.gitignore:5` is `*.log`, so citing
`runs/*.log` here would have pointed at three files git was never going to commit — and a pointer to
an absent file does not read as stale, it reads as "there is nothing here". Caught with
`git check-ignore -v` before the commit, not after.

**Named cells confirmed present in the output** (not inferred from the totals) — the load-bearing
ones, each read back from its log line:

- `connection-control`: `G1`,`G2`,`G3`,`G4`,`G5`,`G6` (the grant gate and its three controls);
  `C1a`,`C1b`,`C1c`; `A1`,`A2`,`A3`,`A3b`,`A3c`,`A3d`,`A3d-univ`; `R1`,`R2`,`R3` (the three named
  refusals); `C2a`,`C2b`,`C2c`; `EX`,`E0` (authed preconditions); `E1`–`E18`, including
  `E16` (the publish/DM asymmetry) and `E17`/`E18` (the space fence with its inverse control).
  **`A3c` ran and passed** — the cell the `TS2367` finding is about; see `FINDING-smoke-unchecked.md`.
- `connection-lifecycle`: `D1a`–`D1e`, `D2a`–`D2k`, `D3a`–`D3m`, plus the four `PRE-ARM`
  preconditions. `D2i`/`D2j` are the discrimination pair; `D3l`/`D3m` are the stale-credential
  return and the control that keeps it from being explained by a credential that never expired.
- `request-strand`: the `CONTROL` arm, the REBUILD arm, the STOP arm, and `ARM3` (admission refusal).

**The two first actions are witnessed in the log, for two of three.** `connection-control` prints
both `[provenance]` (core `dist` built `2026-08-15T00:37:55.373Z`, newer than every
`packages/core/src/*.ts`) and `[safety]` (`nats://127.0.0.1:44063`, asserted not `broker.cotal.ai`,
loopback-only, inherited `COTAL_*` deleted). `connection-lifecycle` prints `[safety]`.
**`request-strand` prints neither.** Its guard is real — `request-strand.smoke.ts:29-30` refuses the
live host and refuses a non-loopback target — and it reads no `process.env` at all, so its target
**cannot** be the inherited `COTAL_SERVERS`. But a guard that prints nothing leaves **no witness in
the run log**, and this file does not upgrade "I read the source" into "the run demonstrated it".
Recorded as a gap in that suite's reporting, not repaired here.

**What this does NOT discharge.** The `meshctl-m*`, `72`, `72b` and `m10` probes in this directory
were not re-driven in this pass; every count sourced from them is still **stamped**. `pnpm smoke:ci`
was not run — no gate until fm-orchestrator releases one.

## Re-drive of the m-probes at `fe279b94` — nine confirmed, one newly UNBLOCKED and FAILING

Same window, `01:13:58` → `01:18:10 UTC` (`date -u` at the moment of each run). Copies were made
into each probe's package home, run, and **deleted**; `git status --porcelain` was empty after each
batch, so nothing untracked was left behind.

| probe | home | exit | result | vs record |
| --- | --- | --- | --- | --- |
| `meshctl-72-gap` | runs in place | `0` | 7 asserted + 4 recorded, 0 failed | identical |
| `meshctl-72b-leak` | runs in place | `0` | 3 asserted + 2 recorded, 0 failed | identical |
| `meshctl-m8-outage` | runs in place | `0` | 5 passed, 0 failed, 0 hung | identical |
| `meshctl-m10-twoviews` | runs in place | `0` | 5 passed, 0 failed | identical |
| `meshctl-m3-fence` | `packages/core/` | `0` | 9 passed, 0 failed | identical |
| `meshctl-m6-durable` | `packages/core/` | `0` | 4 passed, 0 failed | identical |
| `meshctl-m5-lease` | `packages/core/` | `0` | Q1 CONFIRMED, Q2 MARKED-not-deleted | identical |
| `meshctl-m5-verify` | `packages/core/` | `0` | Q1 CONFIRMED, Q2 MARKED-not-deleted | identical |
| `meshctl-m7-usermode` | `implementations/auth/` | `1` | **2 passed, 1 failed, 7 VOID** | was NOT-YET-RUN |

Those eight are now **confirmed, not stamped**. `m7` is a new result and it is a bad one.

### `m7` is unblocked and it does not pass — no user-mode evidence exists

The probe header recorded it `⚠️ NOT YET RUN — BLOCKED ON THIS WORKTREE`: `implementations/auth`
had no `node_modules`. **It has one now**, so the probe loads and runs. It fails.

**Defect 1 — the fixture minted a token its own product correctly refuses. FIXED HERE.** It
back-dated `iat`/`nbf` by 60s (clock-skew tolerance) while setting `exp = now + 900`.
`verifyUserToken` caps the token's **lifetime**, `exp - iat` (`implementations/auth/src/token.ts:159-160`),
against `MAX_TOKEN_TTL_SEC = 900` (`token.ts:30`) — so the fixture signed a **960s** token and the
callout denied **every bearer it produced**, including the correctly-signed one. The product is
behaving exactly as specified; the probe was wrong. Changed `exp` to `now + 780` (lifetime 840s, off
the boundary rather than exactly on it).

**Proven by a named, discriminating predicate rather than by the suite getting greener:** occurrences
of `exceeds the 900s cap` in the run log went **74 → 0**. Nothing else about the run was changed.

**Defect 2 — NOT fixed, and it is why `m7` still has no evidence.** With the cap denial gone, `U0`
still fails: `auth callout: denied …: signature verification failed`. So the callout rejects the
correctly-signed bearer for a second, independent reason.

**`UX` passing is worth nothing while `U0` fails, and this is the exact pattern this lane keeps
finding.** `UX` asserts a bearer signed by the WRONG key does not connect — and it is green. But
`U0` is its inverse control, and `U0` says the RIGHT key does not connect either. **A fixture in
which no bearer can connect makes every denial trivially true.** `UX` is not evidence of a
verifying callout; it is evidence that the arms could not differ. The probe's own contamination
machinery caught this and marked `U2`–`U8` **VOID** rather than green — the machinery worked, and
without it seven cells would have reported a supervisor property that was never exercised.

**Defect 3 — `m7` prints its terminal marker and then never exits.** It reached
`M7 USER-MODE FAILED ❌ (2 passed, 1 failed, 7 VOID)` and `[cleanup] broker group signalled`, then
sat in the connector's reconnect loop, which keeps the event loop alive. It was killed by a
10-minute timeout at `143`. **`143` is the timeout's exit code, not the probe's verdict** — a suite
that never exits hands you a number that means nothing about the code. The verdict had to be read
out of the log.

**Standing: the user/bearer path is UNMEASURED.** `m7` is the only probe covering it. Nothing in
this file about user-mode connection control is measured, and any DESIGN sentence resting on `m7`
is a **[R]**, not an **[M]**, until defect 2 is fixed and the probe re-driven.

### Housekeeping done in the same window

A `nats-server` from an **earlier** `m10` run was still live on `/tmp/meshctl-m10-z2xQRI`, port
`37525`, elapsed `02:22:19`. It was **not** from tonight's run: `ps lstart` prints **local** time
(`+0200`) while every stamp in this file is `date -u`, and reading the two as the same clock would
have mis-blamed the run that had just finished two minutes earlier. Elapsed time is what settles it.
Signalled by **process group** (`kill -TERM -2661509`) rather than by pid, confirmed gone, and both
stale scratch dirs removed. No `nats-server` and no `/tmp/meshctl-*` remained afterwards.
