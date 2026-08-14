# M-C1 — MEASURED, and it matched the prediction cell for cell

Mutant: delete the `unattributed` branch from `managerClaim`, so a reply from a DIFFERENT manager
instance falls through. Prediction committed at `76f54f3b`, **before the file was touched**.

| | predicted | observed |
| --- | --- | --- |
| RED | the 5 named in `prediction.txt` | **exactly those 5, by name** |
| GREEN | the other 44 | **44** |
| rc | 1 | **1** |
| marks | 44 (baseline 49) | **44 (baseline 49)** |

`pnpm mutation-proof`: **KILLED**, red and named on the PIN cell.

## The named prediction that mattered was the one about a GREEN

`PIN: a sibling's affirmative reply is NOT serving` was predicted to **stay green**, and did. The
fall-through claims (`wedged`/`absent`) already set `serving: false`, so a cell watching only
`serving` cannot see this mutation at all. Naming that in advance is what stops the four real
catches from being reported as five.

## Why this mutant is worth more than a wrong label

With no local process, the fall-through does not merely mislabel — it **grants a start hint over a
manager that just answered**. The defect is a recommendation to launch a second manager against a
live one, which is the failure mode the instance pin exists for. That is why the property cell
(`a start hint is offered ONLY when nothing answered AND no local process exists`) reddens: the
danger is in `startHint`, not in the claim string.

## ⚠️ What this does NOT prove, and it is a live gap

`mutation-proof` prints it and it applies in full here: *"this proves the suite DEPENDS on the
mutated code. It does not prove a real entry point reaches that code — if the test builds its inputs
by hand, prove that separately."*

**These cells build every input by hand, and nothing calls `managerClaim` yet.** The ready card has
not been wired to it. So the decision table is proven to discriminate and is proven to be *reachable
by a test*, and is **not** yet proven to be reachable by `cotal setup`. Until the card calls it and a
live arm drives a real manager, this is a correct function that no operator can see.
