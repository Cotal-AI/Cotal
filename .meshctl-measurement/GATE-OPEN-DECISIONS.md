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

## 4. The `SIGKILL` residual on mutation proofs — OWNER: fm-orchestrator. ACCEPTED, then DISSOLVED.

`SIGKILL` is uncatchable and strands a mutant in `packages/core/src`. Accepted on stated reasons:
the consequence is **source, not build** (nothing executes it until a `tsc`, which the freeze
independently prevents — two disjoint failures required); recovery is driven, not assumed
(`git checkout -- <file>`); and nothing on this box sends it while serialized.

**Closed as a decision. Left open as a fact** — see `SIGNAL-SAFETY-mutation-proof.md`. The change
that removes the residual entirely is limit #2's closure route, recorded and deliberately not built.

### DISSOLVED 2026-08-15T08:36Z — and the distinction from *resolved* is load-bearing

Limit #2's closure route was built. **The harness mutates a COPY of `src` and never the tree**, so
**there is no shared write left for a `SIGKILL` to strand.** Proven in MX16 by an mtime that did not
move, not by a diff (`runs/2026-08-15T0835Z-mx16-window.txt`, containment fact 3).

**Recorded as DISSOLVED, not RESOLVED, on fm-orchestrator's instruction, because the two decay
differently:** a *resolved* risk returns the moment its fix is reverted — a one-line change nobody
announces. A *dissolved* one returns only if the **architecture** changes back to writing a shared
artifact, **which is a loud event.** Anyone reading this later should treat a future proposal to
mutate in place as re-opening item 4, and should expect to see it argued rather than merged.

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

## 10. `packages/core/dist` has writers whose names do not say "build" — OWNER: nobody yet, and that is the point

**Raised by fm-orchestrator 2026-08-15T08:4xZ, from fm-webconsole's scan of its own branch.** A
`:live` smoke on another branch gained `pnpm --filter @cotal-ai/workspace... build && …`. The `...`
suffix means *"and its dependencies"*, and workspace depends on core — **so a script named
`smoke:setup-pure:live` rebuilds `packages/core/dist`.** It was added for a correct reason (the
smoke was reading a stale build) and it predates the current rulings. **It is not to be changed:
removing a stale-build fix to protect a measurement trades a real defect for a convenient one.**

### The finding is wider than the script that surfaced it — measured in THIS tree, at tip `e5e84366`

`package.json` here, on this lane's own branch, has **fifteen scripts whose body invokes a build**,
every one of them via the dependency-inclusive `...` form that reaches `packages/core`:

- **twelve are named `smoke:*`** — `smoke:codex-installed`, `smoke:manager-console`,
  `smoke:orca-e2e:live`, `smoke:delivery-renewal`, `smoke:update-concurrency`,
  `smoke:materialize-concurrency`, `smoke:setup-failloud`, `smoke:agent-skills`,
  `smoke:ext-seed-help`, `smoke:seed`, `smoke:seed-tarball:live`, `smoke:persona-announce`;
- **two are `ci:*`**, and **one is `typecheck`** — already a standing item, and the reason it is
  standing is the same reason as this one.

**So the writer set is not "`pnpm build`, plus one surprise on someone else's branch". It is at
minimum sixteen entry points, most of them named for something other than building, already present
here.** Read from `package.json` text; **`pnpm` was not invoked to confirm the expansion** (no
`pnpm` in this worktree, standing order), so the `...`-includes-core step rests on documented pnpm
filter semantics, not on an observed run.

### What this changes about every containment argument on this branch

> **A containment argument inherits every writer of the artifact it contains.** This branch bounded
> the writers it knew about; this one arrived through a script whose name says "smoke".

`packages/core/dist is stable` was being used as a **property**. It is a **measurement**, valid at
the moment it is taken. Every place this branch cites dist stability now carries its scope with it.

**What the decision actually is, and why it is not this lane's:** whether a `smoke:*` script may
write the fleet-linked artifact at all — and if so, whether the name should say so. Fixing it inside
one script fixes one of sixteen.

### AMENDED 2026-08-15T09:0xZ — it is not "a `:live` smoke can write it". THE GATE CHAIN WRITES IT.

Census by fm-artifact-4, read statically from the gate manifest with no builder invoked.
**Independently reproduced here** by parsing this tree's own `package.json` — same eight, same
names, arrived at without seeing the other census's method:

```
smoke:ci  ->  215 entries, of which EIGHT invoke a build:
  smoke:delivery-renewal   smoke:codex-installed    smoke:materialize-concurrency
  smoke:seed               smoke:setup-failloud     smoke:agent-skills
  smoke:ext-seed-help      smoke:persona-announce
Both filter roots reach core: `cotal-ai...` (core among ten workspace deps)
                              `@cotal-ai/workspace...` (core its only one)
```

**And `check` is worse than `smoke:ci`.** `check` opens with `typecheck`, whose body is
`pnpm build && pnpm -r typecheck` — **a full build, entry one** — then runs `smoke:update-concurrency`
(builds), then `smoke:ci` (eight more), then `smoke:setup-pure:live`. **A single `pnpm check` writes
`packages/core/dist` at least ten times.**

**`smoke:dist-freshness` is entry 1 of the gate chain, and it VALIDATES that `packages/core/dist` is
fresh.** The chain checks the artifact once and then rewrites it eight times afterwards. **The gate
validates a state the gate itself does not preserve.**

### The consequence for any lane watching that artifact

> **`packages/core/dist` byte-identity is not violated by an escape during a gate run. It is
> violated BY the gate run** — eight times — **and a byte-identity check cannot tell you which cause
> it saw.**

Except that in this repo it cannot even see the gate run: **`tsc` over unchanged source is
deterministic, so those eight rewrites produce identical bytes.** A byte comparison sees neither the
escape it was built for nor the gate that would mask it. **The instrument that sees both is `mtime`**
— which is why the MX16 record was re-grounded on it (`runs/2026-08-15T0835Z-mx16-window.txt`,
addendum).

**fm-orchestrator has recorded the sequencing half as its own error (§187): fm-artifact-4's arm was
queued after this lane's window on the belief that its chain READS this artifact.** That is recorded
there and is not restated here as this lane's finding.

### RE-CHECKED 2026-08-15T09:1xZ — the membership, with indices, and a warning about my own method

Three lanes agreed on **eight** and did not agree on **which eight**. Re-measured here with a strict
classifier (`pnpm [-r] [--filter X] build\b` — a build *invocation*, not the substring "build"):

```
this tip's smoke:ci chain: 215 entries
entry 105  smoke:delivery-renewal          entry 161  smoke:setup-failloud
entry 129  smoke:codex-installed           entry 162  smoke:agent-skills
entry 159  smoke:materialize-concurrency   entry 163  smoke:ext-seed-help
entry 160  smoke:seed                      entry 205  smoke:persona-announce
`smoke:build-current` is NOT DEFINED in this tree and is NOT in this chain.
```

**Membership matches the corrected set by name.** The indices differ between lanes because the chain
length differs per tip — 215 here, others report 222/223/240. **Each is right about its own tip and
they are not reconcilable into one number; do not try.**

> **⚠ MY ORIGINAL CLASSIFIER WAS UNTESTED, AND ITS AGREEMENT WAS LUCK.** I matched the substring
> `build` anywhere in the body. **That rule misclassifies any script whose NAME contains `build` but
> whose body invokes none** — it cannot tell the two apart. Re-run here, loose and strict give an
> identical set, difference `[]`, **only because no such entry exists in this tree.** **A method
> whose correctness depends on the absence of the input that breaks it is untested**, and it
> reproduced a correct answer by an incorrect route.
>
> **RETRACTION, same date:** the concrete example first relayed to me — `smoke:build-current` as a
> live misclassification — **is withdrawn at its source.** That script is **not defined in this tree
> and not in the principal's**, and is in no chain at any tip; it was a third lane's discarded first
> pass in its own tree. **The membership difference between lanes was never a classifier error: both
> published sets were correct about different tips.** `105/129/159/160/161/162/163/205` is this
> tip's, verified; a 227-entry tip legitimately yields `106/130/…/217`.
>
> **The rule that came out of it: STATE YOUR TIP WITH YOUR SET.** Membership is a property of a tip
> in exactly the way the count is — comparing sets across tips assumes position is tip-invariant,
> and it is not. **The critique of my method above stands on its own and does not depend on the
> retracted example.**

## 11. Links into the principal's dependency directories — OWNER: the human. **NOT a writer; a DELETE path**

**Registered 2026-08-15T09:2xZ** on fm-orchestrator's request to record the link found in
`/tmp/rev-join-security`, a tree outside every sweep run tonight. **Verified here** — one link, and
the target is the worst one available:

```
/tmp/rev-join-security/packages/core/node_modules  ->  /home/david/Cotal/packages/core/node_modules
```

### It was handed to me as "alongside the eight gate writers", and that is the one thing it is NOT

**It does not write `packages/core/dist`, and it cannot supply core to a bare specifier.** Measured:
that directory holds **5 entries, no `dist`, and no `@cotal-ai/core`.** It is a **dependency**
directory.

**What it is instead is a deletion path.** A `pnpm` invocation in that tree, at that package, targets
the **live checkout's** `packages/core/node_modules` for removal; the no-TTY abort is the only thing
in the way and `CI=true` disables it. **And this lane holds the identical link** — the same target,
from a second tree — so `packages/core/node_modules` has at least two trees able to delete it.

**Filing it under item 10 would have repeated the exact currency error this branch has been
correcting all night: a writer of the artifact and a link into the package are different claims.**
Item 10 stays a list of writers; this is its own item because the mitigation is different — item 10
is about when the artifact changes, this is about a directory ceasing to exist.

**Second-order, and it is why the target matters:** the principal's `packages/core/node_modules` is
itself made of climbing links into **this** worktree's store (`ajv`, `yaml`, `json-canonicalize`,
the `@nats-io/*` set). **Deleting it destroys the principal's resolution AND severs links whose
other end is here.**

### The instruction that replaced the clearance — adopted here

**No lane relies on anyone's box-wide clearance.** Before any `pnpm`, a lane checks **its own tree**:
`find <tree> -name node_modules -type l`, then `readlink -f` each. Run here at `09:2xZ`: **six, all
resolving into the principal** — `bin`, `implementations/{cli,delivery,manager}`,
`packages/{core,workspace}`.

> **A glob is a hypothesis about where things live; `git worktree list` is the population.** The
> sibling of this branch's own rule: an instrument that takes *the others* as its subject cannot
> report on the one running it; one that takes a *naming convention* as its subject cannot report on
> what is named otherwise. **Both are a scope silently narrower than the sentence describing the
> result.**

**Nothing repointed, removed or tidied.** The link is load-bearing for whatever installed it, and
that is not established.
