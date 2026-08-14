# Mutation record — connection-lifecycle repair

Base: the fix commit `325aaa50` + suite `3c1055e3`, worktree `/home/david/Cotal-wt-fm-meshctl`.
Suite: `packages/core/smoke/connection-lifecycle.smoke.ts`, **20/20 green at base**.

**No VOID risk on this suite, and it was checked rather than assumed.** It imports
`../src/index.js` relatively through `tsx`, so a mutation in `packages/core/src` IS the code that
runs. (The *connector* suite is the opposite and that trap already cost me four VOID runs: it
resolves `@cotal-ai/core` → `extensions/connector-core/node_modules/@cotal-ai/core` →
`/home/david/Cotal-wt-fm-meshctl/packages/core/dist/index.js`, measured with
`import.meta.resolve`, so it needs a `tsc -p packages/core` before every run.)

Every prediction below was written to disk **before the first run**
(`scratchpad/PREDICTIONS.md`), including the one I expected to survive.

---

## MX1 — remove `doRebuild`'s post-dial cleanup  → **KILLED**

Mutant: restore the bare `await this.connectAndBind();`.

| cell | predicted | observed |
|---|---|---|
| D1a refusal is `bind-failed` | RED | RED — reason flipped back to `broker-unreachable` |
| D1b nothing live at the broker | RED | RED — **`{ current: 1 }`** |
| D1c endpoint holds no connection | RED | RED — **`{ hasNc: true, self: true }`** |
| ARM 2, ARM 3 | GREEN | GREEN (17 passed, 3 failed) |

**Non-equivalence, at the broker:** `current: 1` is `nats-server`'s own `/varz` reporting a live
connection *after the caller was told the connect was refused*. Not a reddened cell — a connection.

## MX2 — restore the original `disconnect()` ordering  → **KILLED**

Mutant: drop every broker handle and emit `connection:false` first, drain after.

| cell | predicted | observed |
|---|---|---|
| D2b retraction reported only if sent | RED | RED — text flipped to `COULD NOT BE RETRACTED` |
| D2c observer does not see offline | RED | RED — **`{ status: 'offline', activity: 'disconnected: arm2' }`** |
| D2d not stranded in a third state | RED | RED — `{ hasNc: false, self: false }` |
| ARM 1, ARM 3 | GREEN | **NOT OBSERVED — see below** |

**Non-equivalence, at the broker:** D2c's value is read from an INDEPENDENT observer endpoint's
presence view, i.e. off the broker's KV. Under the mutant a peer sees the agent as departed while
the agent is still connected — the ghost, reproduced.

**MY "GREEN ELSEWHERE" PREDICTION FOR MX2 WAS NOT CONFIRMED, AND I AM NOT CLAIMING IT.** D2e also
reddened (the control disconnect then refused `not-connected`), which left the shared subject
endpoint in a state ARM 1 and ARM 3 assume away, so D1c and D3c reddened downstream. That is
**cascade contamination, not independent evidence**: the arms share one endpoint and one broker.
It is a real weakness of the suite — the arms are not independent — and it is recorded here rather
than smoothed over. The named cells reddened on their own values; the extra reds prove nothing.
(First run of MX2 crashed the harness outright at the restore line. I hardened the restore to use
the captured connection object so the mutant's later cells stay observable, then re-ran. The
hardening is in the committed suite.)

## MX3 — remove the whole renewal fence  → **KILLED**

Mutant: both arm guards, the entry fence, the in-transaction fence, and `disconnect()`'s
`clearTimeout` — all five sites.

| cell | predicted | observed |
|---|---|---|
| D3b source not called while off | RED | RED — **`{ at: 1, now: 3 }`** |
| D3c broker sees no new connection | RED | RED — **`{ before: 3, after: 7 }`** |
| ARM 1, ARM 2 | GREEN | GREEN (18 passed, 2 failed) — clean, no cascade |

**Non-equivalence, at the broker:** four authenticated connections dialled by an endpoint that had
deliberately left the mesh. Independently reproduced by `rev2-meshctl-authority`, which reached the
same place from the other direction (marker `DRIVE_TIMER_PREFLIGHT_REPRODUCED`).

## MX3a — remove ONLY `disconnect()`'s `clearTimeout`, keep every fence  → **SURVIVED (predicted)**

20/20 green. The entry fence in `renewCredsOnTimer` returns before any work, so the cleared timer
is **defence in depth, not the load-bearing part**. Registered as a survival prediction in advance
and it held.

I am reporting this rather than folding it into MX3, because "MX3 killed" would otherwise imply all
five sites are proven and only three are. The honest statement: **the fences are proven; the
`clearTimeout` is not, and it stays as belt-and-braces, not as tested behaviour.**

---

## What this record does NOT cover

- **ARM 3 is core-API only.** A creds SOURCE is not a state `cotalToolSpecs` can construct
  (`MeshAgent` passes static creds bytes), so nothing here shows a *tool caller* can reach the
  renewal arm. `rev2-meshctl-authority` refuted that reachability itself, unprompted, and I am not
  re-asserting it.
- **Arm independence.** MX2 showed the three arms share a fixture. Not fixed.
- **No repo-wide suite was run.** No gate has been released to this lane. Scoped suites only:
  `connection-lifecycle` 20/20, `connection-control` 19/19, `request-strand` 9/9.
