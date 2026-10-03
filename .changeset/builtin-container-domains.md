---
"@cotal-ai/lang": patch
---

The record and array builtins refuse an argument of another kind in the language, so a program can no longer branch on an answer the host made up for a value it was never meant to take.

Each of these builtins read its record or array argument through a host operation that answers for any kind. Measured before the fix, on both engines: `map(5, f)` and `keys(5)` answered `[]`, `every(5, f)` answered true, `pick(5)` answered undefined, `has(f, "length")` answered true off the implementation's function wrapper, `keys("ab")` answered index strings, `concat("a", [1])` answered `"a1"` past L4018, and `keys(null)` refused with the host's error text.

`keys`, `values`, `entries`, `has` and both arguments of `merge` now take a record, and `map`, `filter`, `find`, `some`, `every`, `sort`, `slice`, `join`, `reverse`, `unique`, `sum`, `pick` and the first argument of `concat` take an array. Every other kind, a string, `null` and `undefined` included, is refused with L4016 naming the builtin and the kind, before the host is reached, as `len` already was. The refusal is catchable. The second argument of `concat` keeps the method's meaning. The spec's library-failure section, its replay posture and its change log carry the rule in the same change.
