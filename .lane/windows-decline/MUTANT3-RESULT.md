# M-WD3 — 14 red, exactly the 14 predicted, and the two that stay green stayed green

Preregistered at `2ae20e3a`; this file is a later commit. `date -u` for the closing sweep:
**2026-08-15 03:06:29Z**.

## Result

Mutation identical to M-WD1 (`declined.push(cmd);` → `measured++; /* MUTANT-WD1 collapse */`,
unique in both directions), replayed against the 32-cell suite.

**14 red, exactly the predicted set.** The three new ones:

```
✗ MD.1 passed differs from declined
✗ MD.4 all three exit statuses are pairwise distinct
✗ MD.5 a machine reading ONLY the exit status recovers all three states
```

**Predicted green, and green:** `MD.2 declined differs from failed`, `MD.3 passed differs from
failed`.

## Why MD.2 and MD.3 surviving is the useful part

A pairwise must-differ cell is only a control for **the pair it names**. The collapse merges
*passed* into *declined*, so the pairs that do not mention both are blind to it — and if the suite
had only the three pairwise cells, two thirds of them would report green while two states had
become indistinguishable.

`MD.4` (set cardinality) and `MD.5` (classify from the exit status alone) are the cells that see a
collapse between *any* two of the three. That is why both forms are present, and it is the reason
the must-differ requirement is not satisfied by asserting each arm against a literal: three true
cells can coexist with two states that a supervisor cannot tell apart.

`MD.5` also pins the discriminator to a **machine-readable channel** — it classifies with stdout
discarded entirely, so the distinction cannot be satisfied by prose in the summary. A display field
is not a protocol field.

## Closing sweep, at a tree with 0 uncommitted entries

| run | result |
| --- | ------ |
| `smoke:shard-status` | **32 passed, 0 failed**, rc=0 |
| `smoke:gate-inventory` | rc=0 |
| `smoke:delivery-health` | **38 passed, 0 failed**, rc=0 |
| `smoke:delivery-health-live` | **17 passed, 0 failed**, rc=0 |
| `typecheck` | rc=0 — **reported separately**, because node strips types and a green suite does not imply a green typecheck |

All rc values read from EXIT-trap artifacts, never from a pipe.

## Not claimed

- **No gate.** `smoke:ci` was NOT run. Every item above is a suite and is named as one.
- **No real-Windows reachability.** All declined paths are reached through a shim. Proven: the
  suite depends on this code. NOT proven: that a Windows runner reaches it.
- No live broker. `shard-status` spawns only a shim; `delivery-health-live` asserts its broker URL
  is loopback and not the live host as its first action.
