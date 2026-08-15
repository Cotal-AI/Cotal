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
