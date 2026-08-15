# MX14's SURVIVED was VACUOUS, and it corrects what I reported at CLOSE

> ## ✅ RESOLVED 2026-08-15T08:36Z — the same mutation was re-run and KILLED
>
> **MX16** (`runs/2026-08-15T0835Z-mx16-window.txt`) ran this exact mutation with the resolution
> fixed and it **died on the predicted cell** — `R1 disconnecting again refuses as [not-connected]`,
> 44 marks against a 45-mark baseline. The pre-registered prediction (`63ddca6e`, unrun, unamended)
> named SURVIVED as its refutation and did not get it.
>
> **What fixed it:** a per-process resolver hook redirects the bare specifier for **every** importer
> (`scripts/private-core-hook.mjs`), the mutation is applied to a **copy** of `src` so the tree is
> never written, and grading is gated on a subject-side **class-identity** assertion instead of a
> string the suite prints about itself.
>
> **The diagnosis below is unedited.** It is kept because the mechanism it describes is the one that
> had to be understood, and because "compiled is not executed" is the defect class, not the incident.

**Stamped `2026-08-15T07:2xZ` (`date -u` at writing), lane tip after `cb6c91ae`. Diagnosis by
reading only — no broker, no mutation, no box.**

## What I said at CLOSE, and what is actually true

I reported: *"The mutant WAS compiled and WAS executed. SURVIVED means what it says."*

**The first half is right and the second half is wrong.** The mutant was compiled into the private
build. **It was never on the code path R1 exercises.** SURVIVED is therefore not evidence about R1's
assertion strength — it is evidence that a core mutation cannot reach a connector-driven cell
through this seam at all.

**I checked the vacuity I anticipated (was the private build rebuilt after mutation? yes, line 188
→ 191 → 220 → 221) and accepted the result on the strength of it. That check was sound and it was
not the whole question.** Compiled is not executed, and I treated one as the other.

## The mechanism, in three measured facts

```
suite's own core import      importCore(CORE_ENTRY)  -> the PRIVATE build   (mutated)
suite builds the agent       new MeshAgent(...)  from ../src/agent.js       (connection-control.smoke.ts:190)
connector's core import      "@cotal-ai/core"    -> packages/core/dist/index.js   (import.meta.resolve)
```

**R1 calls `cotal_disconnect` against `A`, a `MeshAgent`.** So the refusal it asserts is produced by
core-from-`dist` — the shared, *unmutated* build. The mutant sat in a private build that only the
suite's own direct imports resolve to.

`endpoint.ts:1413` is genuinely the disconnect-again site, and R1 genuinely drives it. **Nothing is
wrong with the cell that this run can show.** The run simply never reached it.

## The seam's confirmation line is weaker than it looks

`scripts/mutation-proof.mjs:310` refuses unless the suite's output matches `/PRIVATE build/`. That
line is printed by the suite from **its own** import (`connection-control.smoke.ts:112`). **It
confirms that a private build was loaded. It does not confirm that the code under test resolves
there** — and for every cell driven through `MeshAgent`, it does not.

The comment at `scripts/mutation-proof.mjs:217` states the assumption in as many words: *"compile it
into the PRIVATE build so the suite executes it."* **That assumption is false for connector-driven
cells**, and it is stated nowhere else.

## The trade nobody wrote down

**Before the seam**, a core mutation was compiled into `packages/core/dist` — which is exactly why
it reached the connector, and exactly why it reached every agent session on this box
(`FINDING-mutation-on-shared-dist.md`). **The mutation proof worked *because* it was dangerous.**

**After the seam**, the mutant goes somewhere only the suite resolves. The shared artifact is safe —
proven, 276 files byte-identical — and **core mutations no longer reach any cell driven through the
connector.**

> **The seam did not weaken the proof by accident; safety and reach were the same property, and
> removing the hazard removed the reach with it.** That is the real finding of MX14, and it is worth
> more than the KILL I predicted.

## What this does and does not invalidate

- **It does NOT invalidate the seam.** The seam's own claim — a mutation proof cannot write the
  fleet-linked build — held exactly as specified.
- **It DOES mean `--private-build` cannot currently grade `packages/core` through
  `connection-control.smoke.ts`.** Any core mutation run this way will SURVIVE regardless of cell
  quality. **A proof that cannot fail is not a proof**, and this is the harness's own listed lie
  ("the mutation silently does not apply") wearing a different mechanism.
- **It says nothing about `connection-lifecycle.smoke.ts`**, which imports core from `../src/*.js`
  directly under `tsx` and never needed a build. Unmeasured here.
- **It says nothing about R1's strength either way.** R1 is UNGRADED, not weak. Claiming it is weak
  would repeat the same error in the opposite direction.

## What would fix it — recorded, NOT built

**Redirect the bare specifier for the suite process**, so the connector's transitive
`@cotal-ai/core` resolves to the private build too — a Node resolver hook registered via
`--import`/`module.register`, mapping `@cotal-ai/core` → `COTAL_CORE_ENTRY`. Then one env var
governs every importer in the process rather than only the ones that opted in through
`_core-entry.ts`.

**And the harness's confirmation must then assert the thing it claims**: not "the suite printed
`PRIVATE build`", but that the module actually under test resolved there. Otherwise the next reader
inherits the same false assurance with a hook bolted on.

**Not built tonight, and not decided by this lane.** It is a change to how every suite resolves core.
