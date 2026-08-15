# `mc-rev-cleanup` — the cleanup fix and its proof — **BLOCK at `9243a45b`**, cleanup findings CLEARED

Received by DM, landed verbatim. Anchor `9243a45bfa8b6d1014df194fa053d5aa1182e907`.
**Part 1 of 2** — the second part is appended below when it arrives.

**Read the disposition carefully, because the headline and the substance point opposite ways.** The
two SUPPLEMENT findings this seat was spawned to grade — the false `already-connected` refusal and
the unbounded half-bound connection leak — are **CLEARED**. The BLOCK is for a **collateral
regression** that the same seat found in static work before it ever took the broker, and which was
already fixed at `cc3f0b87` **after** its anchor. **It says explicitly that the follow-up is outside
its mandate and NOT re-graded, so the fix is UNGRADED and the BLOCK stands until it is.**

---

## Part 1 — verdict

VERDICT 1/2 — **BLOCK at anchor `9243a45bfa8b6d1014df194fa053d5aa1182e907`**, written from `date -u`: Sat Aug 15 03:45:39 UTC 2026. The two SUPPLEMENT cleanup findings themselves are **CLEARED**; the anchor is blocked by one collateral gate regression.

**HIGH / RELEASE BLOCKER — removing the open-mode bypass broke the real tool-doc generator.** Its representative config has neither capability, then calls the now-gated `cotalToolSpecs`, while annotations still require both verbs; the script throws `orphaned annotation cotal_disconnect`. `scripts/generate-tool-docs.mjs:18-28,163-166 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`; gate/filter `extensions/connector-core/src/tool-specs.ts:155-183,804-810 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`; `check:docsbundle` and `ci:version` invoke it at `package.json:15-19,28 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. I drove the real entry directly (never pnpm): rc=1, one error occurrence by `grep -c`; `/tmp/opencode/mc-rev-cleanup-docgen.log:1-14 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. I inspected `9243a45b..cc3f0b87`: only `scripts/generate-tool-docs.mjs` moves and it adds explicit `connection` + `spawn`; that follow-up is outside my mandated anchor and not re-graded here.

**CENSUS / ONE ROOT — confirmed.** `connectAndBind()` has exactly two callers: initial `start()` at `packages/core/src/endpoint.ts:720-730 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`, and serialized rebuild at `packages/core/src/endpoint.ts:1261-1318 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. The third grep hit is the definition at `:995-999`; there is no third caller. Both callers now clean the post-dial failure.

**RESOURCE CENSUS — no active connection-scoped handle omitted.** The bind assigns `nc`, status watch, JS/KV handles, watches, consumers, heartbeat, and optional Plane-3 arm at `packages/core/src/endpoint.ts:1023-1129 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. `discardHalfBound()` clears scoped loops/caches plus every nc-bound client handle and then closes the owning connection at `:1132-1180`; `clearConnectionScoped()` stops consumer iterators and native chat subs at `:1182-1216`, all @ the anchor. Plane-3 control refs are removed/replaced on the next arm at `:3290-3309 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`; closing `nc` kills their old subscriptions meanwhile. `credsTimer`/`bearerTimer`, durable-membership mirrors, and caller-owned `subs` are endpoint-lifecycle state deliberately preserved across rebuild, not connection-scoped; deliberate disconnect/stop clears credential timers at `:1488-1494,1620-1623 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

**CLEANUP ERROR MASKING — no reachable mask found.** `start()` rethrows the captured original `e`. Every externally fallible cleanup action (`msgs.stop`, `unsubscribe`, `halfBound.close`) is caught; the remaining operations are internal timer/collection clears. `packages/core/src/endpoint.ts:720-730,1160-1216 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. I did not manufacture a proxy/corrupted-internal-state throw and call it production reach.

Fresh private-broker current-tip run: lifecycle 48 passed / 0 failed, full 37/37 roll call; D4 has seven green named cells by `grep -c`. `/tmp/opencode/mc-rev-cleanup-connection-lifecycle-9243.log:65-82 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

---

## Lane response to part 1 (NOT part of the verdict)

**THE BLOCK IS UPHELD AND IT IS NOT DISCHARGED BY MY HAVING FIXED IT.** I reproduced the same
failure independently and fixed it at `cc3f0b87` before this verdict arrived — but **the seat states
in the verdict that `cc3f0b87` is outside its mandate and not re-graded.** So the repair to a HIGH
release blocker is currently **UNGRADED**, and a fix nobody has graded is not the same as a cleared
finding. I have asked it to re-anchor and grade `cc3f0b87`. **Until it does, this lane is BLOCKED,
and I am recording that rather than quietly treating my own fix as the discharge.**

**THE CENSUS IS THE RESULT I MOST NEEDED AND COULD NOT TAKE MYSELF.** My entire "one root, one fix"
framing is false if a third `connectAndBind()` caller exists without a cleanup arm. It counted
three grep hits, identified one as the definition at `:995-999`, and confirmed **exactly two
callers**. That is the claim I explicitly told it I could not safely grade about my own code, and it
is now graded by someone with no stake in the answer.

**THE RESOURCE CENSUS CLOSES A BLIND SPOT I NAMED IN ADVANCE.** I told it: *every cell I wrote counts
SOCKETS, so a handle the cleanup forgets is invisible to all of them.* It walked the bind's
assignments against `discardHalfBound()`'s clears rather than trusting the socket count, and drew a
line I had not drawn explicitly — **`credsTimer`/`bearerTimer`, durable-membership mirrors and
caller-owned `subs` are endpoint-lifecycle state deliberately preserved across a rebuild, NOT
connection-scoped.** That distinction is what makes "no handle omitted" a finding rather than an
opinion: it says what SHOULD survive, not merely what does.

**THE ERROR-MASKING REFUSAL IS WORTH MORE THAN THE FINDING WOULD HAVE BEEN.** *"I did not manufacture
a proxy/corrupted-internal-state throw and call it production reach."* It could have produced a
reachability finding by building a fixture that reaches nothing real. **A reviewer that declines an
available finding because its provenance is wrong is the second one on this panel to do so** — the
first was `mc-rev-refusal` refusing to promote my fixture bug into a production-provisioning
finding — and both times the restraint is what made the surrounding verdict usable.

**AND IT RE-DROVE THE SUITE RATHER THAN READING MY LOG.** Its own private broker, its own run:
lifecycle 48/0 with the full 37/37 roll call and D4's seven cells counted by `grep -c` rather than
eyeballed. **A second party reproducing my numbers is the one thing I structurally could not
supply**, and the roll call means it reconciled cells-run against cells-declared exactly as §46
requires.

---

## Part 2 — verdict, authority + proof

VERDICT 2/2 — authority + proof.

**AUTHORITY OF THE PRE-FIX SOCKET — usable, but not widened.** I injected the exact cleanup omission at runtime on the real `CotalEndpoint.start()` entry: a credential provisioned for role `worker` was presented by a card claiming `wrong-role`, so the authenticated socket passed handshake and failed the role consumer bind. With cleanup suppressed, broker current was baseline+1 and `nc`/`js` remained; an in-ACL `#general` publish received PubAck, while the same half-bound connection's `#secret` publish was broker-denied. With current cleanup, the identical wrong-role start returned to baseline, held neither `nc` nor `js`, and the same in-ACL publish refused `endpoint not started`; the valid-role inverse control connected with the same credential. `/tmp/opencode/mc-rev-cleanup-authority-9243.log:2-10 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. The producing order is `nc/js` before fallible binds at `packages/core/src/endpoint.ts:1023-1044,1083-1092 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`, and publish uses that JS handle at `:1648-1673,2572-2575 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

Judgment: the old defect was not an inert memory leak; a rejected session retained its already-granted broker authority. It was an admission/resource failure with live authority, **not a broker-authorization widening**: the forbidden subject stayed forbidden. I drove publish; I did not promote that into a universal claim about every raw subscribe shape.

**GATE / MODES.** Fresh real tool-surface smoke: ungranted static, user-mode config, and open mode all omit `cotal_disconnect`/`cotal_connect`; each granted inverse exposes them. `/tmp/opencode/mc-rev-cleanup-connection-control-9243.log:7-13 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. The same run finished 45/0/0 VOID (`grep -c` confirms 45 checks) and the auth arm preserved concrete read, subtree-read, publish, and foreign-space fences at `:41-75 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

`cotal_reconnect` is correctly outside the `connection` grant **for the documented policy boundary**: it is an always-available recovery rebuild, takes no target, and refuses to reverse deliberate self-disconnect; it cannot create the persistent unreachable state the grant controls. `extensions/connector-core/src/tool-specs.ts:774-782,804-810 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`; `packages/core/src/endpoint.ts:1357-1389 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`; `docs/mcp-tools.md:289-297 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. Residual: a compromised agent can repeatedly churn recovery and cause transient self-unavailability; withholding `connection` is operational policy, not protection from a process that can close its own socket.

**MUTATION PROOF — discriminating and broker-non-equivalent.** The mutant removes only the new `start()` cleanup and leaves rebuild cleanup intact. Prediction names D4a/b/c and M11a/b red, ARM1 and acceptance controls green, with full roll calls required. `.meshctl-measurement/MUTATION-STARTLEAK.md:14-62 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. Result is exact broker divergence: D4 current=3, M11 peak=18/current=17; ARM1 and both acceptance controls stay green; D4d/f are explicitly recorded as cascade and D4e was strengthened after it survived. `:66-121 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`. Fresh real `MeshAgent.start()` run made 18 accepted retry attempts (`grep -c`), M11 6/0, full 3/3 roll call, nothing after stop. `/tmp/opencode/mc-rev-cleanup-m11-9243.log:8-37 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

The `baseline+1` peak tolerance can hide one connection that is merely in flight at a sample, but not the reported one-per-attempt growth: M11-ctl requires at least four accepted attempts, M11b checks after stop, and ARM4 separately checks baseline after all failed starts. D4's short settle poll can hide a delayed-but-eventually-closed socket, not a persistent orphan. Box load biases the timing arm only toward **fewer** retries, so it can hide growth and cannot manufacture it; this run still observed 18 accepted failures.

Window released after process-group shutdowns and awaited exits; no matching scratch dirs/processes remained. Worktree is clean, HEAD remains the anchor, dist mtime remained 05:15:48, and I invoked no pnpm.

### Supplement — the paired arms, on request

Sent on `#review.fm-meshctl` after I asked whether the authority sentence had an inverse control.

World **A**, non-vacuous, on the **same half-bound socket**.

1. In-grant arm: `await half.multicast("half-bound permitted publish", { channel: "general" })` **resolved** (JetStream PubAck path). The instrument recorded verbatim: `"inAclAccepted":true,"inAclError":""`.
2. Out-of-grant inverse: `await half.multicast("half-bound forbidden publish", { channel: "secret" })` **threw** verbatim: `Permissions Violation for Publish to "cotal.cleanup-auth-ebf35ddb.chat.local.UAB5VBQASPFRGUUJTUPVFGVWAPWHYPRSESGF7WPNW5O4P2L5EAQP36BP.secret"`. The instrument recorded `"outAclDenied":true` beside that exact error.
3. The start had rejected first, verbatim: `Permissions Violation for Publish to "$JS.API.CONSUMER.INFO.TASK_cleanup-auth-ebf35ddb.svc_wrong-role"`; broker current was baseline+1 and both `hasNc`/`hasJs` were true. Same credential, same socket, paired arms. `/tmp/opencode/mc-rev-cleanup-authority-9243.log:3-4 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

**Refutation condition stated before banking it now:** an out-of-grant `#secret` PubAck on that half-bound connection would refute the fence and reclassify this as authorization widening. Failure of the in-grant arm would void the denial as a dead instrument. Neither occurred. I tested publish authority, not every raw subscribe shape, so my sentence is bounded to publish.

Current-fix inverse, same wrong-role condition: start rejected with the same TASK permission error; broker returned to baseline, `hasNc:false`, `hasJs:false`; the in-grant publish then threw verbatim `endpoint not started`. That is a **bare core throw**, not a named `ConnectionOutcome` or tool refusal. I am not claiming §9.2 closed; the result proves authority removal, not caller taxonomy. Valid-role inverse with the same credential then connected. `/tmp/opencode/mc-rev-cleanup-authority-9243.log:5-7 @ 9243a45bfa8b6d1014df194fa053d5aa1182e907`.

---

## Lane response to part 2 (NOT part of the verdict)

**THIS IS THE ANSWER TO THE LANE'S CENTRAL QUESTION AND IT IS NOT MINE.** The brief requires that a
self-connect carry **"nothing it did not already hold"**. What this seat established is stronger and
about a state I did not design for: **in the failure mode, on a session the broker had REJECTED, the
fence still held.** The forbidden subject stayed forbidden. A rejected session kept the authority it
already had and gained none.

**I asked for the inverse control before I would bank it, and I was right to.** *"Could publish only
within its existing grant"* is true in two worlds — one where the fence refused an out-of-grant
publish, and one where the socket could not publish at all and nothing ever reached the fence. **In
the second world the sentence is true and means nothing.** It drove both arms on the SAME socket:
in-grant `#general` resolved with a PubAck, out-of-grant `#secret` threw a verbatim permissions
violation. **World A, non-vacuous**, with the refutation stated before the result was cited.

**ITS RECLASSIFICATION IS SHARPER THAN EITHER OF THE TWO LABELS I HAD.** I had framed this as
"resource leak, or authorization defect". It is neither, exactly: **an admission/resource failure
with LIVE AUTHORITY.** A rejected session is not inert — it retains what it was already granted —
so the severity is not a memory leak's and the audience is not an authorization defect's. That is a
third category and it is the accurate one.

**AND IT BOUNDED ITS OWN CLAIM TWICE, UNPROMPTED.** *"I drove publish; I did not promote that into a
universal claim about every raw subscribe shape."* And: the post-fix refusal is a **bare
`endpoint not started` throw, not a named outcome — so §9.2 is NOT closed**, and it said so rather
than letting a green result be read as taxonomy coverage. **A seat that volunteers the limit of its
own strongest finding is the reason that finding is usable.**

**ON `cotal_reconnect`:** confirmed correctly outside the grant, with a residual I am recording
rather than dismissing — a compromised agent can churn recovery into transient self-unavailability.
**Withholding `connection` is operational policy, not protection from a process that can close its
own socket.** That sentence belongs in §5, because it bounds what the grant can honestly claim.

**IT ALSO GRADED MY TOLERANCES RATHER THAN ACCEPTING THEM**, which is the part I would have skipped:
`baseline+1` can hide one in-flight connection but not one-per-attempt growth, and D4's settle poll
can hide a delayed-but-eventually-closed socket but not a persistent orphan. **Both are real limits,
both are bounded, and neither reaches the defect measured.** That is what grading a tolerance looks
like, as against restating it.
