# `mc-rev-supervisor` — supervisor observability — **BLOCK, HIGH**

Received by DM in two parts, landed verbatim in order. Pin
`66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. The second message **rescopes the finding from a design
debt to a shipped-behaviour defect** and corrects two things in my briefing; both are kept.

---

## Part 1 — the BLOCK

BLOCK — HIGH: §3's supervisor-cause seam is not real at the pinned product.

Own worktree: `git rev-parse HEAD` = `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e` (detached, clean). I noted the m7 arms are "sequenced against log cursors"; that later measurement does not change this pinned product finding.

CONFIRMED — HIGH finding

Concrete state in: a connected endpoint publishes the ordinary freeform activity `disconnected: requested`; its presence heartbeat then stops while its routing connection remains live. State out: after TTL, an independent external observer/UI renders it `offline: disconnected: requested`, yet a channel publish from that endpoint is delivered. The endpoint then performs a real `disconnect("requested")`; the external observer/UI renders the byte-for-byte same line. Those states require opposite supervisory action, but the supervisor view cannot distinguish them.

Live loopback reproduction, with controls, on the product-identical lane tree:
`PASS CONTROL-online-before-heartbeat-loss {status:"idle",activity:"disconnected: requested"}`
`PASS working-endpoint-derived-offline {status:"offline",activity:"disconnected: requested"}`
`PASS CONTROL-routing-still-live-while-roster-offline`
`PASS CONTROL-deliberate-disconnect-succeeded`
`PASS same-status-and-activity`
`PASS same-cotal_roster-output`
Both rendered: `· subject/worker — offline: disconnected: requested`
`VERDICT GHOST-REPRODUCED failures=0`; `EXIT=0`.

Why: `disconnect()` stores the cause only in freeform `activity` (`packages/core/src/endpoint.ts:1394-1403 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). Any live endpoint can set that same activity (`packages/core/src/endpoint.ts:1967-1970 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). `Presence` has no transition/cause/source discriminator (`packages/core/src/types.ts:70-89 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). Stale-heartbeat materialization and explicit offline both preserve `activity` and become `status:"offline"` (`packages/core/src/endpoint.ts:4263-4267,4309-4333 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). `cotal_roster` renders status/activity but not timestamp, revision, or transition source (`extensions/connector-core/src/tool-specs.ts:253-270 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). This is the reported failure class: presence says gone while routing/process truth says working, so absence is converted into a false answer and duplicate seats can be minted.

The committed A2/E5 cells prove only that a chosen string appears. E5's label claims this means "a deliberate departure is not a crash", but it has no stale/crash must-differ arm (`extensions/connector-core/smoke/connection-control.smoke.ts:393-399 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). My must-pass live arm passed while the two supervisor outputs remained identical. That discrimination premise is REFUTED.

CONFIRMED separately
- The happy-path operation itself is broker-observable, actually closes routing, resists self-heal, and is self-reversible: fresh rerun `connection-control` 45 passed / 0 failed / 0 VOID, `EXIT=0`; the committed pinned log names A1/A2/A3c/A3d/C2c (`.meshctl-measurement/runs/2026-08-15T0109Z-connection-control.txt:20-38 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`).
- Failed teardown retraction and connect cleanup held: `connection-lifecycle` 39/0, `EXIT=0`.
- Rebuild/stop request settlement held: `request-strand` 9/0, `EXIT=0`.
- A mesh-only supervisor cannot recall the endpoint; the agent can call `cotal_connect`, and a process controller is the intended out-of-band recovery. The process-controller claim is code-read, not live-proven here.

REFUTED
- §3's narrower claim that freeform activity makes deliberate departure distinguishable from crash/staleness. Text is visible; trustworthy cause is not.
- The brief's incidents are not themselves proof of mechanism. The live reproduction independently confirms the same ghost class; it does not establish the exact historical root cause of either incident.

COULD NOT DETERMINE
- The exact cause of the evening-long stale record: no raw KV revisions, heartbeat errors, or process/connection trace survived in the supplied artifacts.
- Agent-held leases/claims at self-disconnect remain explicitly unmeasured (`.meshctl-measurement/RESULTS.md:241-244 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`).
- Exact tool-path durable replay is not proven: M6 measures one direct membership across `stop()`, while RESULTS admits no `cotal_disconnect`/`cotal_connect` replay proof (`.meshctl-measurement/RESULTS.md:199-205,223-225 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`).
- The pending-request latch covers `requestBounded`/legacy `nc.request`; the ep-rail path is not in `pendingRequests`. I did not reproduce a wrong ep-rail outcome, so this remains a question, not a finding (`packages/core/src/endpoint.ts:1384-1392,1806-1837,1868-1907 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`).
- User/bearer behavior is unmeasured at the pinned tip.

Instrument provenance: direct attempts in my detached worktree exited 1 before executing any cell because that checkout has no local `dist` or per-package dependencies; I did not count them. I verified `git diff --quiet 66bb07d1..47e008f -- packages/core/src extensions/connector-core/src packages/core/smoke extensions/connector-core/smoke` returned 0, then ran the three suites and the ghost instrument in that product-identical lane worktree. The connector suite's own freshness guard passed.

Clear condition: a machine-readable supervisor-visible transition/source/cause discriminator, rendered by `cotal_roster` and an external observer/UI, plus a must-differ test with (1) deliberate disconnect, (2) heartbeat-stale but routing-live, and (3) crash. If a wire change stays out of scope, §3 remains partially undelivered and this lane must not claim safe supervisory discrimination.

---

## Part 2 — rescoped, and two corrections against my briefing

BLOCK — HIGH, RESCOPED TO SHIPPED PRODUCT BEHAVIOUR at `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. My own worktree remains pinned there. The correction strengthens the disposition: this is not a design debt to record before implementation; it is a false supervisory guarantee on the live tool surface.

Which statement is right:

- `DESIGN.md` is right that there is no wire `cause`/transition-source field. `Presence` contains status, freeform activity, attention/modes, lifecycleUid and ts only (`packages/core/src/types.ts:70-89 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`).
- `tool-specs.ts:782-783` is literally true only in the weakest display sense: the chosen cause string appears to an observer because `disconnect()` writes `activity = "disconnected: <cause>"` (`packages/core/src/endpoint.ts:1394-1403 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`) and `cotal_roster` prints activity (`extensions/connector-core/src/tool-specs.ts:253-270 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`).
- The stronger sentence on the same line — a supervisor sees "a departure rather than a silence" — is false as a reliable product contract. `activity` is ordinary caller-controlled text (`packages/core/src/endpoint.ts:1967-1970 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`), and both stale-derived offline and explicit offline preserve it (`packages/core/src/endpoint.ts:4263-4267,4309-4333 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). There is no machine-readable source/cause seam.

The independent live proof already sent is product-level, not note-level: heartbeat-stale but routing-live and truly disconnected produced the byte-identical `cotal_roster` line `· subject/worker — offline: disconnected: requested`; routing delivered in the first state; the actual disconnect succeeded in the second; all controls passed, `EXIT=0`. Thus "cause string was displayed" is confirmed, while "the supervisor can distinguish the departure" is refuted. U5/E5 assert only the former under a label claiming the latter.

Your retry-loop evidence needs two corrections before it is used:

1. It is not a `cotal_disconnect` counterexample. That subject never completed initial bind and never had a deliberate departure to announce. The connector logs retry locally (`extensions/connector-core/src/agent.ts:246-263 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`); presence is first published only after connect, KV open, lifecycle proof and consumer bind (`packages/core/src/endpoint.ts:990-1034,1064-1108 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`). It does show there is no wire-visible `connecting` transition, but that is a separate connect/startup observability gap, not the proof of this disconnect finding.
2. The count in the briefing is wrong. With a positive-control match on the terminal marker, `/usr/bin/grep -c` over `2026-08-15T0226Z-m7-usermode.txt` gives **72** `mesh unreachable … retrying in 300ms` lines and **111** occurrences of `JS.API.CONSUMER.INFO.TASK`. The lane's later RESULTS says those 111 came from a fixture role omission and indict the fixture, not product. After that fixture repair, the good user-mode arm connects and U3-U7 run; U5 remains the same non-discriminating substring assertion. Therefore I do not use the 111-count run as product evidence, and the BLOCK does not need it.

Net verdict: optional cause text is shown on the happy path, but supervisor-visible causal identity is not carried. The tool description conflates those claims and overpromises the latter. Because the feature is already built, this is a shipped documentation-plus-behaviour defect. Clear only with a machine-readable transition/source/cause discriminator (or an equally authoritative out-of-band supervisor seam), surfaced by `cotal_roster`/an external observer/UI, and a must-differ test covering deliberate disconnect, heartbeat-stale-but-routing-live, and crash.

---

## Lane response (NOT part of the verdict)

**Both corrections in Part 2 are accepted and both were against me.**

**(1) I used the retry loop as a disconnect counterexample and it is not one.** That subject never
completed its initial bind, so it had no deliberate departure to announce and never published
presence at all. **What it actually shows is a separate gap — there is no wire-visible `connecting`
transition — and conflating the two would have let a startup-observability observation masquerade as
proof of the disconnect finding.** The seat declined to accept evidence that pointed its way.

**(2) My `~55 reconnect attempts` was an estimate over a two-author log.** Re-derived: **72**
`retrying in` lines whole-file, **28** in S's own window, **111** `CONSUMER.INFO.TASK`. `~55` is
`111/2` — **BAD's retries in the denominator of S's exec count.** Shared instrument, two authors,
attributed to one. **That is the exact class I had asked the evidence seat to hunt, committed in the
message that asked for it.**

**And it refused to use my strongest-looking number.** It set the 111-count run aside as fixture
noise and stated plainly that **the BLOCK does not need it** — declining evidence that favoured its
own conclusion. The finding is stronger for resting only on its own controlled reproduction.
