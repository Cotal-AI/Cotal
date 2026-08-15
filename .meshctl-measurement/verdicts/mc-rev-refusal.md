# `mc-rev-refusal` — refusal taxonomy — **BLOCK**

Received by DM, landed verbatim. Pin `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.

**Two parts.** The FIRST verdict is below; the **SUPPLEMENT** — filed after I sent it the correction
that product code HAD changed — is at the end, and it is the part that **GATES this lane**. The
supplement does not retract the first verdict; it raises the scope, and its findings 1 and 2 share a
single root that neither the first verdict nor I had located.

**This seat is NOT released.** fm-orchestrator's ruling: when the cleanup fix lands, a FRESH seat is
briefed **from this file** at the new tip, rather than mc-rev-refusal being revived. That is only
possible because the verdict is on disk — which is the whole argument for landing verdicts before
acting on them.

---

BLOCK — refusal taxonomy is neither truthful nor caller-safe at the pinned tip.

HEAD from my worktree: 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e. I read that the m7 arms were "sequenced against log cursors".

CONFIRMED

1. HIGH — reachable failures get the wrong named reason. Natural loopback repro: start with JetStream, reconnect after the same auth broker restarts without JetStream. Broker total connections rose 1→4 (the broker accepted connections), the bind failed with `jetstream is not enabled`, but `ReconnectFailure.reason` was `broker-unreachable`. `reconnect()` discards the post-dial state at `packages/core/src/endpoint.ts:1351-1355 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; `connect()` correctly passes that state at `:1535-1544 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. A second direct-source repro held phase constant before any dial: a creds source throwing `vault unavailable` returned `broker-unreachable`; changing only its English to `credential source unavailable` returned `credential-source-unavailable`. The source runs before `connect()` at `:990-1014`, while classification text-matches at `:383-396`, both @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e. The taxonomy is controlled by wording, not the condition that failed.

2. HIGH — materially different end states collapse into one reason. Driving `disconnect()` with only broker-write outcomes fault-injected produced: reassert succeeded and failed → both `transition-unconfirmed`; retraction succeeded and failed → both `teardown-failed`. The failed-repair arms say an external observer/UI may still show offline while the endpoint is live, which requires different action, but a caller branching on `reason` cannot tell. See `packages/core/src/endpoint.ts:1404-1422` and `:1465-1478` @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e. Plausible wrong caller: `if (r.outcome === "refused" && r.reason === "teardown-failed") retryLater();` accepts both the repaired and still-uncertain states. This needs a structured repair-status discriminant or split reasons, not English in `detail`.

3. HIGH — the good discriminant is repeatedly dropped before the tool caller. `MeshAgent.reconnect()` returns `reason` at `extensions/connector-core/src/agent.ts:309-328 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`, but `cotal_reconnect` throws it away and returns only `err(r.message)` at `extensions/connector-core/src/tool-specs.ts:769-776 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. `cotal_send` likewise flattens every thrown cause at `:343-349`; the already-written classifiers/diagnostic are at `packages/core/src/endpoint.ts:4508-4559`, all @ that hash. The committed live artifact shows the better endpoint diagnosis and raw caller denial side by side at `.meshctl-measurement/runs/2026-08-15T0109Z-connection-control.txt:58-62 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.

Judgment on route-note §2: it answers only a separate preflight query. It names `no-route`/`unknown-channel`/`not-connected` at `.meshctl-measurement/DESIGN-route-refusal.md:236-255 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`, then explicitly declines interposing on send at `:300-304`. Therefore it does NOT answer the measured `cotal_send` denial/outage surface. The actual send result itself must carry a typed named outcome (including unknown/PubAck ambiguity), or the caller still gets raw transport text after skipping the advisory query.

4. MEDIUM — "the caller gets `isError=true`" is true only at `spec.run`/MCP, not universally at a host. MCP preserves it at `extensions/connector-core/src/tools.ts:15-18`; OpenCode converts it to a normally resolved warning string at `extensions/connector-opencode/src/tools.ts:39-42`, both @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e. The suite itself admits no host was exercised at `.meshctl-measurement/RESULTS.md:214-219 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. Obvious wrong caller `try { await execute(); return "success" } catch { return "refused" }` therefore reports success on OpenCode. At core I drove the even simpler `if (await ep.connect()) callerReported = "connected"`; actual outcome was `refused`, callerReported was `connected`, exactly as `packages/core/src/endpoint.ts:341-346 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e` admits.

REFUTED

The old claim that denial and outage are indistinguishable is false, and the brief is right to strike it: denial is a permissions violation; outage is `timeout`. `.meshctl-measurement/meshctl-m8-outage.smoke.ts:159-210 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. What survives is narrower: neither is a typed, actionable caller outcome.

COULD NOT DETERMINE

The real user/bearer path remains unmeasured: its only probe fails its positive control and voids seven cells, `.meshctl-measurement/RESULTS.md:536-573 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. I also did not claim a live OpenCode-host run; the pinned worktree lacks package-local dependencies, and the lane's own inventory says no host request ran. The renderer's normal-resolution behavior above is source-confirmed.

---

## Lane response (NOT part of the verdict)

**Finding 1 is the sharpest thing this panel produced and it is not disputed.** The repro held the
phase constant before any dial and changed **only the English** of a thrown error — `vault
unavailable` classified as `broker-unreachable`, `credential source unavailable` classified as
`credential-source-unavailable`. **A reason derived by matching the TEXT of a failure is not a
classification of the failure. It is a classification of the message, and it changes when someone
rewords a string with no behaviour change at all.** The classifier text-matches at
`endpoint.ts:383-396` while the source that actually failed runs at `:990-1014`.

**Its judgment on my own route-note is accepted and is the more useful half for me.** §2 answers a
separate *preflight query* and then explicitly declines to interpose on send — so it does **not**
answer the denial/outage surface I measured. **A design that names refusals for a query the caller
may skip has not given the caller a typed outcome; it has given it an optional one.**

**Finding 4 lands on a claim I made myself.** *"The caller gets `isError=true`"* holds at
`spec.run`/MCP and **not at every host**: OpenCode converts it to a normally-resolved warning
string, so the obvious `try { … } catch { … }` caller **reports success on a refusal**. My own
inventory already admitted no host was exercised — **which means I shipped a universal claim on a
surface I had explicitly recorded as unmeasured.**

---

# SUPPLEMENT — filed after the correction — **BLOCK REMAINS**, and this is the gating half

Received by DM, landed verbatim below. Occasioned by my own correction: I had told the panel "no
product code has changed", which was false — the verbs are built at `6e8d7cd9`. **This seat spent the
correction on a second, harder measurement rather than on re-reading its first one.**

One omission, named so it is not mistaken for an edit: the DM closed with the seat echoing its
launch-time privacy binding back to me verbatim. That paragraph is **my** text, not its finding, and
it is dropped here. Nothing else is changed, reordered, or elided.

---

BLOCK remains - the correction raises scope and adds a more direct shipped-product block. This supplements rather than retracts my prior verdict.

HEAD from my worktree remained 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e throughout; worktree stayed clean.

CONFIRMED

1. HIGH - `cotal_connect` can emit the named refusal `[already-connected]` when the endpoint is NOT connected. I reproduced the exact post-auth role-consumer denial against a fresh loopback auth broker at the pin. Before the failed start the broker had 1 current connection. After `start()` rejected on `Permissions Violation for Publish to "$JS.API.CONSUMER.INFO.TASK_<space>.svc_worker"`, it had 2; no `connection:{connected:true}` event had fired, but `ep.nc` was populated. Calling `connect()` then returned `{outcome:"refused", reason:"already-connected", detail:"this endpoint is already on the mesh"}`. This is the tool description naming a false condition.

The producing path is explicit: initial `start()` calls `connectAndBind()` directly at `packages/core/src/endpoint.ts:720-727 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; the transport is assigned before fallible binds at `:1014-1083`; role binding fails at `:3741-3753`; the half-bound cleanup exists only inside `doRebuild()` at `:1244-1277`; then `connect()` equates any residual `nc` with already connected at `:1499-1505`. `renderOutcome` faithfully turns that false reason into caller text at `extensions/connector-core/src/tool-specs.ts:51-70`, and the description promises the condition at `:789-795`, all @ the pinned hash.

2. HIGH - the initial retry path leaks one authenticated half-bound connection per attempt. I drove three failed `start()` calls, the exact call `MeshAgent.connectLoop` repeats. Broker current connections rose 1 -> 4. After stopping both endpoint objects whose handles the fixture owned, current connections were still 2: two overwritten half-bound handles were orphaned. `MeshAgent.start()` is fire-and-forget and retries every failure forever at `extensions/connector-core/src/agent.ts:246-263 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; each new `connectAndBind()` overwrites `this.nc`. `stop()` drains only the latest handle at `packages/core/src/endpoint.ts:1570-1613 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. This is not just noisy logging: a permanent permission mismatch grows live authenticated sockets without bound.

3. HIGH - the knowable permanent bind denial never becomes a caller refusal. The endpoint's good permission diagnosis is consumed into stderr at `extensions/connector-core/src/agent.ts:224-225`; the thrown failure is then relabeled `mesh unreachable` and retried at `:251-262`; orientation exposes only generic `not connected` at `extensions/connector-core/src/tool-specs.ts:180-199`, all @ the pin. No last named failure is retained for a tool/model caller. The later evidence log's 111 count is real (`git grep -c` returned 111; first occurrence `.meshctl-measurement/runs/2026-08-15T0226Z-m7-usermode.txt:5 @ f1e0d375`), and my pinned static-creds repro reached the same product branch. The product defect is the response to a post-auth permission mismatch, independent of who misconfigured the grant.

PROMISE MATRIX

`transition-in-progress` is real: direct `connect()` returned that reason, produced by `packages/core/src/endpoint.ts:1502-1503 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. Handshake credential rejection is real: against one live broker, its trusted credential connected and an otherwise identical credential from an untrusted account returned `auth-rejected`, produced by `:1535-1544` plus `:383-396` @ the pin. Clean `already-connected` is also covered by R3, but the half-bound state above refutes the description's unqualified promise. Two of the three advertised branches hold; one names the wrong condition on a reachable product state.

REFUTED / LIMIT

The 111-line run does NOT show that the real user-mode provisioner omits the role grant. `f1e0d375` records that the fixture omitted `role` while the real ledger resolver supplies it (`.meshctl-measurement/meshctl-m7-usermode.mts:60-68 @ f1e0d375`). I am not promoting a fixture bug into a production-provisioning finding. What it exposed, and what I independently reproduced at the product pin, is the shipped endpoint/connector behavior once any post-auth bind permission is wrong.

COULD NOT DETERMINE

Whether a revoked bearer or narrowed user-mode grant is caught on return remains outside this supplemental proof. The current description promises it, but this turn tested the three named refusal branches and the permanent-bind path, not ledger revocation.

---

## Lane response to the supplement (NOT part of the verdict)

**Findings 1 and 2 are accepted, are BLOCKING under fm-orchestrator's revised ruling, and share ONE
root: there is no cleanup on a failed INITIAL bind — only on rebuild.** `doRebuild()` closes the
half-bound handle in the transition that opened it (`endpoint.ts:1244-1277`, with a comment saying
exactly why). `start()` calls `connectAndBind()` directly at `:720-727` and has no such arm. So:

- the residual `nc` makes `connect()` answer `already-connected` for a session that is **not on the
  mesh** — finding 1;
- and every retry leaks the previous half-bound socket, because `stop()` can only drain the handle
  it can still see — finding 2.

**Fix the one thing and both change.** That is fm-orchestrator's framing and it is right; I had been
carrying these as two items.

**The measurement it demands is a POSITIVE, and this is the part I would have got wrong.** A cell
asserting *"`start()` failed"* is **true in the leaking state and in the fixed state alike** — it
cannot discriminate, so it is not evidence. What must be asserted is that **after N failed starts,
the broker's CURRENT connections returns to baseline**, read at the broker, not at the client. The
client is the thing that lost the handle; asking it how many sockets it holds is asking the defect
to report itself.

**Its REFUTED/LIMIT section is a correction to ME and I am recording it as one.** I had offered the
111-line retry log as evidence about the *user-mode provisioner*. It is not: `f1e0d375` records that
**my fixture** omitted `role` while the real ledger resolver supplies it. **The seat declined to
promote my fixture bug into a production finding, and then went and reproduced the same product
branch from static creds instead** — which is why finding 3 survives on its own legs and does not
depend on my log at all. A reviewer that refuses a free finding because its provenance is wrong is
worth more than one that banks it.

**Finding 3 is accepted and is NOT scheduled here.** It is the connect/startup observability gap
mc-rev-supervisor separately identified — a permanent, knowable bind denial is logged to stderr,
relabelled `mesh unreachable`, and retried forever, so no caller ever learns the real reason. It is
recorded in DESIGN §9 as a follow-on rather than folded into the cleanup fix, because it is a
different defect that merely shares a symptom.
