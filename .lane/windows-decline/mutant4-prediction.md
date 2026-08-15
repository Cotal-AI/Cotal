# M-RC1: take the recursion back out, and name the single cell that must notice

Pre-registered. Committed BEFORE the run. Baseline: `smoke:ready-card` **28/0 rc=0** at `fd63a050`,
tree tracked-clean.

## What is being proven

Review's CLAIM 1: the home fingerprint stat'd only five top-level marker paths, so a write below an
already-existing `.agents/skills` did not move `.agents`' own mtime and the comparator could not
see it. Their mutant SURVIVED the full 26-cell suite while a decoy gained
`.agents/skills/team-topology/SKILL.md`.

The repair walks each marker tree. This mutant removes the recursion again. If no cell reddens, the
repair is decoration and review's finding is still open.

## The mutation

`bin/smoke/ready-card.smoke.ts`

- **find** (unique): `for (const e of readdirSync(abs).sort()) walk(join(abs, e), \`${rel}/${e}\`);`
- **replace** (unique the other way): `/* MUTANT-RC1 non-recursive */;`

**Non-equivalence:** the fingerprint of a tree containing a descendant write becomes identical to
its pre-write fingerprint. The comparator's output changes for the same inputs.

## Predicted RED — exactly ONE cell, by name

`COMPARATOR: the fingerprint SEES a write to a descendant of an already-existing marker dir`

Predicting **one** and not "the suite goes red" is the point: red alone is not proof, since an
unrelated early failure is also red. If anything else reddens, this prediction is wrong and I will
record that rather than round it off.

## Predicted GREEN, with reasons

| cell | why it cannot see this mutation |
| ---- | ------------------------------- |
| `COMPARATOR-control: the old top-level-only form does NOT see it` | it computes the top-level form explicitly, so it is unaffected by what `homeFingerprint` does |
| `HERMETIC-control: the same comparator DOES report a change for the scratch home` | the scratch home starts EMPTY, so its markers go absent→present at the TOP level; a non-recursive comparator still sees that. **This is exactly why that control was never sufficient on its own** — it only ever proved the comparator could see a top-level creation |
| `HERMETIC: the OPERATOR's real home is byte-for-byte unchanged` | unchanged either way |
| the remaining 24 cells | unrelated to the comparator |
| `CELL COUNT: expected 28` | 28 cells still execute |

That `HERMETIC-control` stays green under this mutant is the substance of review's point: proving a
comparator can see one kind of top-level creation does not prove it can see a protected descendant
write. The suite had the shape of a sound argument without its substance, and the new COMPARATOR
cell is the part that was missing.

## Discipline

Tree asserted clean before the mutant; restore verified with `git diff --quiet`; mutant marker
grepped back to 0.
