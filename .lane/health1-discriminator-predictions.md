# HEALTH-1 discriminator — predictions registered BEFORE the measurement

Author: fm-health. Written at `date -u` = Fri Aug 14 11:49:36 AM UTC 2026 (measured, not estimated;
re-measured at each run below).

Branch tip when these predictions were registered: see the commit that carries this file. The point
of registering them is that **a prediction that lands after the run is a description.**

## The question

`cotal ps` / `cotal attach` against the live mesh exit 1 naming an absent manager id, in ~2.3-2.6s.
That is NOT a timeout — the broker answers "no responders" instantly for an unsubscribed subject.
Two hypotheses, OPPOSITE fixes. Neither is asserted.

- **(A) PER-INVOCATION MINT.** The failing id is built from the CALLER'S OWN freshly minted
  identity, not from any manager's. Four distinct never-repeating ids in ten minutes is not what a
  finite set of departed managers looks like — a stale set repeats.
- **(B) SPLIT MANAGER QUEUE.** The control path picks a registered-but-dead manager out of a
  population nothing prunes; a queue-group pick fails ~2 times in 3 and names a different member
  each time.

## Refutation conditions — STATED IN ADVANCE

| # | Observation | Kills |
|---|---|---|
| R1 | A failing id MATCHES one of the manager ids on the roster at the time of the run | **(A)** |
| R2 | TWO invocations in ONE process produce the SAME failing id | **(A)** |
| R3 | The failing ids MATCH the caller's own connection/identity id from the SAME run | **(B)** |
| R4 | Failing ids are all distinct across runs AND none matches any roster manager id | supports (A), does not yet kill (B) |

R4 is deliberately weaker than R1-R3: it is consistent with (A) but a stale unpruned registry that
never repeats would also produce it. R3 is the only condition that positively identifies the source,
which is why the caller id must be captured from the SAME run and not inferred.

## What would make this measurement WORTHLESS, stated in advance

- Reading the failing id from one artifact and the manager ids from another. The installed
  `cotal` is **0.16.0**; this repo checkout is **0.0.0** (both measured). They are different
  artifacts. Every id pair below records WHICH BINARY produced it.
- Comparing a caller id captured at time T against a roster read at time T+minutes. Managers can
  join and depart between the two. Roster and run must be adjacent and both timestamped.
- Treating id SHAPE as evidence. Measured from source: `DEV_OWNER = "local"`
  (packages/core/src/subjects.ts:362) and the open-mesh caller triple is
  `{ owner: DEV_OWNER, actor: newIdentity().id, … }` (implementations/cli/src/lib/control.ts).
  A caller principal therefore renders `local.U…` — the SAME shape as a manager instance id.
  **Shape alone cannot discriminate and must not be cited as if it could.**

## Candidate mechanisms already located in source (read, not assumed)

Three distinct sites can name an instance id in a control failure. They are NOT the same defect and
the discriminator must say which one fired:

1. `implementations/cli/src/lib/control.ts` — the OPEN-mesh path synthesizes
   `{ owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() }` **per invocation**.
   `newIdentity()` is `createUser()` → a fresh nkey public key every call
   (packages/core/src/identity.ts:22-26). This is a genuine per-invocation mint and is hypothesis
   (A)'s mechanism — but it mints the CALLER, and whether the caller's id reaches the ERROR TEXT
   is exactly what is unmeasured.
2. `packages/core/src/endpoint-invoke.ts:326-329` — `describeBound` throws `failed-precondition`
   naming TWO ids: the instance that won the class queue and the one the handle resolved against.
   Its own comment says the describe and the invoke are separate trips through the same anycast
   queue and that in a multi-instance space this fires on an **ordinary, correct request**. This
   matches the sibling lane's reported text and is hypothesis (B)'s mechanism.
3. `implementations/cli/src/lib/control.ts` `askManagerScatterEp` — `cotal ps` DEFAULT freezes the
   live class from the records registry and reports every frozen instance that did not answer as
   `reachable: false`. A registry holding departed managers surfaces them here. This is a THIRD
   mechanism, neither (A) nor (B), and it is the one that would tie HEALTH-1 to HEALTH-3.

**A counter-fact already in hand against a naive (A):** manager instance ids are PERSISTED to disk
and deliberately preserved across restarts — `loadManagerInstanceIdentity`
(packages/workspace/src/auth-paths.ts:447-459) refuses to mint a fresh id over a malformed file
precisely so "a restart must preserve the logical instanceId (SPEC 13.6)". So MANAGER ids are
stable by construction. If the never-repeating id were a manager's, that persistence is also
broken, which would be a fourth and separate finding.

## What I will run

Read-only against the live mesh, creating nothing. Two invocations, caller id and failing id
captured from the SAME process, roster read adjacent to both, `date -u` at each step.

## Outcome

Recorded in `.lane/health1-discriminator-result.md` in a LATER commit, so the ordering
prediction-then-result is visible in the git history and not merely claimed.
