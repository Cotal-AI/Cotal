# The uniqueness assertions, mutation-proven — and the pair of mutants is the finding

fm-health, 2026-08-15 (`date -u`). Driven through `scripts/mutation-proof.mjs`, which enforces a
clean tree, a green baseline, exactly-1× application, red **on the named assertion**, and a verified
restore. Tree was clean before each run and restored clean after (`git status --porcelain` empty).

Both mutants add a SECOND row labelled `delivery-health` to `implementations/cli/src/commands/status.ts`.
They differ only in **where** the duplicate is emitted, and that difference is the whole result.

## Mutant A — duplicate emitted AFTER the real row

    --command  status-delivery-ok-live.smoke.ts
    KILLED · red, and named: "EXACTLY ONE row is labelled" · 13 marks (baseline 14)

**Exactly one cell flipped: the new uniqueness cell.** Every other assertion stayed green, because
`[0]` still returned the real row and every downstream claim about its text remained true.

**This is the inverse control, and it is the point.** Without the uniqueness assertion, a second row
under this label appended after the first is **completely invisible to the suite** — 13 of 13 old
cells green, nothing to investigate, an output the operator now reads twice with two different
answers. The check earns its place by catching the case that nothing else can see.

## Mutant B — duplicate emitted BEFORE the real row

    --command  status-delivery-row.smoke.ts
    KILLED · red, and named: "EXACTLY ONE row carries this label" · 27 marks (baseline 31)

**Four cells flipped, not one.** The duplicate is emitted first, so `[0]` selects it and the
downstream assertions — non-empty value, names the preflight, says nothing about the daemon — are all
evaluated against the wrong row.

**Those three extra reds are not noise; they are the original defect, reproduced.** This is precisely
what the local-process row at `status.ts:174` did to these cells before the rename: emitted first
under the same label, silently supplying the subject. The difference is that here the assertions
happen to fail, whereas against the pidfile row they happened to **pass** — the pidfile row's text
(`down`, `running (pid N)`) satisfies "non-empty" and does not mention the daemon or a credential.

**So the honest statement of the old exposure is worse than "the cells were fragile": the cells were
asserting true things about a row that was not their subject, and would have gone on reporting a
healthy delivery surface while never once reading it.**

## What this does NOT prove

`mutation-proof` states its own scope: a kill proves the suite DEPENDS on the mutated code, not that a
real entry point REACHES it. Reach is established separately and only for the live cell, by the W1/W2/W3
path witnesses — strings emitted by the code under test on the branch in question. The broker-less cell
drives the real exported `status()` but reaches only the preflight-FAILURE branch.

Neither mutant tests the production trigger: nothing here proves the local-process section and the
health row can render in the same invocation on a real mesh. That needs a mesh with a `delivery.pid`,
which is state built earlier, and it remains unbuilt.
