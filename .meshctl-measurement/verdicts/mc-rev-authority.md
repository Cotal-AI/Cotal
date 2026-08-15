# `mc-rev-authority` — authority / escalation lens — **BLOCK**

Received by DM, landed verbatim. Pin `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.

---

AUTHORITY / ESCALATION VERDICT: BLOCK

`git rev-parse HEAD` from my worktree: `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
Content ack: "sequenced against log cursors".

This is a release-evidence BLOCK, not a claim that I reproduced an unauthorized widening.

BLOCKER
- The user/bearer self-connect authority path has no discriminating run at the pinned tip. The authoritative record is `EXIT=1`, 2 passed, 1 failed, 7 VOID; U2-U8 never evaluated. `.meshctl-measurement/RESULTS.md:516-573 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
- Worse, pinned M7 is not the production authority composition: its bearer omits the production credential claim, `authorizeActor` is `() => {}`, and its ACL resolver is a constant test grant. `.meshctl-measurement/meshctl-m7-usermode.mts:117-150 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. Production instead binds the authority plane, `plane.authorizeConnect`, and `ledgerAclResolver(dir)`. `implementations/auth/src/service.ts:438-476 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
- Concrete uncovered failure scenario: a user-mode agent previously bounded to `general` disconnects; on return, a regression in the production ledger/permission supplier mints `secret` or `>` into the new data-account credential; the agent receives or publishes outside its prior grant. The 93 named green cells can remain green because their widening cells exercise the static `provisionAgent` mint, while M7 neither reaches the production ledger supplier nor asserts an out-of-ACL read/write after return. That is the exact escalation this lens must exclude, so absence of a discriminating production-composed arm blocks sign-off.

CONFIRMED
- The connector grant gate correctly treats static auth and user auth as credentialed: without `capabilities: [connection]` the verbs are absent; open mode alone is permissive. `extensions/connector-core/src/tool-specs.ts:155-177 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. The committed run names G1-G4 green. `.meshctl-measurement/runs/2026-08-15T0109Z-connection-control.txt:6-12 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
- The static-creds path is broker-bounded after self-connect: E8/E10 deny concrete and subtree read widening, E12 denies publish widening, E17/E18 pair own-space success with foreign-space permission refusal, and the run terminates 45 passed / 0 failed / 0 VOID. `.meshctl-measurement/runs/2026-08-15T0109Z-connection-control.txt:40-74 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. Commit `7ca2ab2c1de7753512acfef661835c4cf2c05bb1` records the real process exit as 0.
- Those static widening cells were challenged, not merely green: MX8, MX8c, and MX9 made read-name, read-subtree, and publish widening deliver at the broker and reddened the named cells while controls stayed green. `.meshctl-measurement/MX7-PREDICTION.md:229-257,350-378,442-480 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
- On code read, production user mode derives grant-bearing values from authenticated/server state: exact issuer and exact single-space audience are verified; current row scope/lifecycle is re-read; channel ACL comes from the server-side ledger. `implementations/auth/src/token.ts:127-219 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; `implementations/auth/src/permissions.ts:36-100 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; `implementations/auth/src/ledger.ts:444-501 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. This is structural confirmation only, not a substitute for the missing live arm.

REFUTED
- The premise that connect only re-presents bytes or "mints nothing" is false. `connectAndBind` may re-fetch a stale bearer or creds source, and the user callout mints a fresh data-account JWT on every accepted connection. `packages/core/src/endpoint.ts:990-1032,1487-1498 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; `implementations/auth/src/callout.ts:249-289 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. D3l/D3m also demonstrate stale source re-fetch. `.meshctl-measurement/runs/2026-08-15T0110Z-connection-lifecycle.txt:57-62 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
- Therefore the literal invariant "nothing it did not already hold" is too strong. If the authenticated operator grant is widened while the agent is away, a later connection may legitimately obtain that new scope. The defensible invariant is no scope beyond the issuer-authenticated current grant, never no delta from the old connection.
- The premise that 93 green cells cover this authority question is false. They cover open/static connection control, lifecycle, and request stranding; the only user-mode leg is separately red/VOID.

COULD NOT DETERMINE
- Whether production user mode preserves or narrows authority across `cotal_disconnect` -> `cotal_connect`; no valid cell reaches that composition.
- Whether the caller-chosen inbox nonce can overlap another live principal's prefix. It is the one caller-supplied value entering the minted grant; syntax is constrained, and this feature's endpoint pins one random nonce at construction, but there is no collision/non-overlap reachability attempt here. `implementations/auth/src/callout.ts:259-271 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`; `packages/core/src/endpoint.ts:623-649,1014-1032 @ 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. Question only, not elevated to a finding.
- My current direct reruns are ungraded: the first stopped before any cell on missing `dist`; after a direct core compile emitted artifacts but failed dependency resolution, the second stopped before any cell on missing `zod`. I rely on the committed `7ca2ab2c` exit/cell artifact for the static result and claim no fresh zero.

EFFECT OF THE TWO LATER MEASUREMENT COMMITS
- `9c6066a4` matters epistemically: it correctly withdraws attribution of the signature denial to the good bearer. I do not repeat that claim. But its arms were committed unrun, so "sequenced against log cursors" does not add user-mode evidence and does not clear this BLOCK.
- `c4dd20f2` corrects the inventory. It adds no production user-mode authority cell and does not clear this BLOCK.

CLEARANCE BAR
- Run a real broker arm through the production exchange + authority plane + callout + connector + tool return. Start with a narrow grant; prove in-ACL success and out-of-ACL read and publish denial after return. Before trusting green, mutate the production user-mode ACL mint to widen read and publish independently and require the named cells to red while must-pass controls stay green. Pair foreign-space/issuer denial with own-space success. Until that exists, I cannot sign the core authority claim.

---

## Lane response (NOT part of the verdict)

**Not argued with, on any point.** The core of it — *a test that holds full authority cannot measure
an authorization boundary; it measures the code path with the boundary removed and reports it under
the boundary's name* — is correct about `M7` and I accept it as a standing law rather than a
criticism of one file.

**The refuted premise is adopted verbatim as the lane's invariant**, replacing my brief's own
wording: **"no scope beyond the issuer-authenticated current grant"** — never *"nothing it did not
already hold"*, which is too strong and simply false, because the callout mints a fresh
data-account JWT on every accepted connection and a grant legitimately widened while the agent was
away will be honoured on return.

**Its account of its own failed reruns is the part I would keep if I could keep only one thing:** it
reported both attempts as *ungraded* — stopped before any cell, on missing `dist` and then missing
`zod` — and refused to claim a fresh zero, resting instead on the committed artifact. **A reviewer
that declines to convert its own broken instrument into a green is doing the thing this whole panel
was convened to check.**
