# `mc-rev-refusal` — refusal taxonomy — **BLOCK**

Received by DM, landed verbatim. Pin `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.

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
