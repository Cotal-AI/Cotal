# Open decisions this lane carries to the gate — not defects, and not mine to close

**Stamped `2026-08-15T07:0xZ` (`date -u` at writing), lane tip `b70948a8`.**

**Why this file exists.** Every item below was settled in a DM. A decision whose only record is a
message in one agent's context is not a record — the same failure the pre-window hash condition was
written to prevent, applied to rulings instead of hashes. **If this lane goes away, this file is
what the gate reads.**

Each entry says who owns it, what was already decided, and what is still open. **None of these is a
defect to be fixed by reading harder.**

---

## 1. Should the connection suites join the `check` chain? — OWNER: the human

**Decided:** no, not now. Ruled by fm-orchestrator, and the boundary is stated as a standing rule:
**naming a suite is a lane's call; changing what the aggregate gate runs is not.**

**Why not now**, in the ruling's order of force:

1. The aggregate chain's length is a **live control variable in another lane's experiment** — two
   arms compared on total runtime, meaningful only because chain and load were held constant.
   Extending `check` is the same act as extending `smoke:ci`, frozen for the same reason.
2. These suites carry a **broker dependency and a box-lock**. In the aggregate, every other lane's
   `check` acquires this lane's constraints. **A gate any lane can extend is a gate whose cost every
   lane pays without consenting.**
3. It is fleet-wide, and the owner is neither this lane nor the orchestrator.

**Still open:** whether they join after the freeze lifts, and whether `check` is even the right
home given the broker dependency. `b70948a8` added the names only.

## 2. The two connector symlinks into this worktree — OWNER: the human

`connector-claude-code` and `connector-opencode` resolve `@cotal-ai/core` to **this lane's unmerged
branch**, so every Claude and OpenCode seat on this box executes it. Measured, both links, in
`LIMITS-private-build.md` §5.

**Decided:** nothing. **Still open, and it has an irreversible edge** — repointing them changes what
the fleet loads while the fleet is running. The private-build seam stops a *mutant* reaching them;
it does nothing about the unmerged commits they already execute. **Not this lane's to close, and
this lane has twice declined to close it.**

## 3. The push verb / PR #441 — OWNER: the human

The branch is stale against its PR because of a **history rewrite, not a fork** (proved, not
assumed). Force-push was authorized by fm-orchestrator under three conditions — remote tag first,
`--force-with-lease` never bare `--force`, proof posted on the PR — and then **`git push` was denied
by the permission layer for every seat, including the orchestrator's.**

**Still open:** the push itself. **A denial in a seat's session is the human's decision about that
session** — this lane did not decompose the operation or route around it, and should not.

## 4. The `SIGKILL` residual on mutation proofs — OWNER: fm-orchestrator. ACCEPTED.

`SIGKILL` is uncatchable and strands a mutant in `packages/core/src`. Accepted on stated reasons:
the consequence is **source, not build** (nothing executes it until a `tsc`, which the freeze
independently prevents — two disjoint failures required); recovery is driven, not assumed
(`git checkout -- <file>`); and nothing on this box sends it while serialized.

**Closed as a decision. Left open as a fact** — see `SIGNAL-SAFETY-mutation-proof.md`. The change
that removes the residual entirely is limit #2's closure route, recorded and deliberately not built.

## 5. The E2E live half — OWNER: this lane, BLOCKED

The standing order is that a user-facing surface closes with an E2E stage from **outside** the
build, docs as its only map. **This lane has a user surface, so it is not exempt.** The live half is
blocked on installed-connector version skew (`FINDING-e2e-blocked-by-skew.md` — note that finding
named the wrong artifact on first writing and was corrected in place).

**Carried as a NAMED GAP by prior agreement, not as an omission.** Do not read a green board as E2E
coverage.

**Item 8 belongs to this stage.** It is stated there and NOT restated here on purpose — two copies
of an open question drift, and the copy the E2E team reads would be the stale one. That is the
defect this lane just fixed between two doc pages; repeating it inside the register that exists to
prevent it would be absurd.

## 6. Limits #2 and #3 on the private build — OWNER: #2 this lane, #3 other harness owners

`LIMITS-private-build.md` classifies its five limits by kind. **#1, #4 and #5 will never be closed**
(by design, proven impossible, and someone else's decision respectively) — treating them as backlog
wastes the reader's time. **Only #2 and #3 are work.**

## 7. Disclosure: a de-referenced object still exists locally — OWNER: the human

A retraction commit reintroduced the term it was retracting, as evidence. It was rebuilt via
`reset --mixed` and re-commit, so **no reachable commit carries it**. Amend was not available and
interactive rebase is unavailable in this environment. **The original object is de-referenced, not
removed**, and persists in the local object store until it is gc'd.

**Stated rather than quietly left**, because "not in the history" and "not in the repository" are
different claims and only the first is true.

## 8. Is a credential revoked mid-disconnect caught on return? — OWNER: whoever runs the E2E live half

**UNMEASURED, and it is the sharpest open question on this surface.**

`cotal_connect` takes no target and re-presents the credential the session was launched with. What
was measured is that a disconnect/connect pair re-presented the **cached** credential without
fetching a new one. **What was never measured is whether a credential revoked while the agent was
away is caught on the way back.**

> **It is the difference between "connect asks for nothing new" as a BOUND and as a GUARANTEE.**
> A bound describes what was observed; a guarantee describes what cannot happen. **The same sentence
> serves as both until someone has to rely on it** — and the person relying on it is an operator
> deciding whether to grant `connection`.

**Docs already take the narrow side** (`docs/agent-files.md`, and the generated `docs/mcp-tools.md`
from `tool-specs.ts`): assume a revocation is NOT re-checked on return until someone measures it.
Fixed in `02e9df9e`, where the two pages had contradicted each other on exactly this.

**Why it is not settled here:** it needs a broker and a live revocation, and the box is serialized.
It cannot be answered by reading the client — the fence is the broker.

**Owner is the E2E live half (item 5), not this lane**, because that stage is where a live broker
and a real revocation exist. Item 5 points here rather than restating it.

## 9. Should the mutation harness redirect the bare specifier for the whole process? — OWNER: the human

**The problem is measured, not proposed.** `--private-build` cannot grade `packages/core` through
`connection-control.smoke.ts`: the mutant reaches the private build, the cells drive a `MeshAgent`,
and the connector's `@cotal-ai/core` resolves to the shared `dist`. **Any core mutation run that way
survives regardless of cell quality** (`FINDING-mx14-survived-vacuously.md`, `5231e102`).

**The candidate fix, recorded and NOT started:** register a Node resolver hook via
`--import`/`module.register` mapping the bare `@cotal-ai/core` to `COTAL_CORE_ENTRY`, so **every**
importer in the process is redirected rather than only the ones that opted in through
`_core-entry.ts`.

**And the harness's confirmation must then assert the thing it claims:**

> **Assert that the module under test RESOLVED there — not that the suite PRINTED a line.**
> `mutation-proof.mjs:310` matches `/PRIVATE build/` in output the *suite* prints about its *own*
> import. **A guard that reads a message the subject prints about itself is checking the messenger.**

**Why it is the human's:** it changes how every suite in the tree resolves core, not just this
lane's. **Not started, and not to be started by this lane on its own reading.**

### UPDATE 2026-08-15T08:4xZ — a HARNESS-SCOPED hook was built and run. THIS ITEM STAYS OPEN.

**Boundary, confirmed by fm-orchestrator before it was built and restated here so nobody has to
reconstruct it:** the hook lives in the mutation harness, is active for the lifetime of **one run**,
**no suite's source changes**, and **nothing about how this tree resolves core by default is
altered**. `scripts/private-core-hook.mjs` + `private-core-register.mjs`, injected as `--import`
through `NODE_OPTIONS` by `mutation-proof.mjs` only when `--private-build` is passed.

**Both halves of the item were addressed:**

- the redirect now covers **every** importer in the proof's process, so a connector-driven cell can
  be graded — `MX16` **KILLED** the mutation that `MX14` survived vacuously
  (`runs/2026-08-15T0835Z-mx16-window.txt`);
- the messenger check is gone. Grading is gated on `.meshctl-measurement/meshctl-m15-resolution-
  probe.mts`, which asserts **class identity on the object the subject constructs**, with a
  discrimination arm that fails if the private and shared builds are the same object. The old
  `/PRIVATE build/` string match is retained and printed as **weak**; it decides nothing.

**What is still the human's, and it is the whole of the original question:** whether anything
FLEET-WIDE should redirect the bare specifier. Nothing outside a `--private-build` run is affected
today, and this lane did not and will not change that.

**One consequence to weigh at the gate:** the harness now writes a **copy** of the mutated package's
`src` and never the tree, which closes `LIMITS-private-build.md` #2 and retires the `SIGKILL`
residual in item 4 as a practical matter (item 4's acceptance stands as written; the residual it
accepted no longer has a shared write to strand).
