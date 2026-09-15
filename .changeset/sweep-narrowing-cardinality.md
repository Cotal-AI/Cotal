---
---

Refuse a recursive sweep that has been narrowed back to a single named file. A sweep counts as coverage because it never enumerates its subjects, so one `continue` on an equality against a single known path turned it back into a named read while it was still graded as a sweep. The listing witness now asks what cardinality the guard chain between a listing and its read admits, so a sweep pinned to one entry is refused and a sweep filtered by extension, by prefix, or not at all still covers the source it finds.

Cardinality is a property of the guard rather than of how the guard is spelled, and the two earlier attempts at this answered the question by recognising spellings, which is defeated by definition: the set of ways to write a condition is open and a list of cases is finite. The classifier is now two functions that decide by resolution and evaluation instead. A call counts as the entry only when its callee **resolves** to the global `String` — the identifier, undeclared in every enclosing scope, called directly and never through a property access — so a projection through a property named `String`, or through a local binding that shadows it, is a projection again rather than the identity conversion its terminal name suggested. The guard itself is **evaluated** over its boolean structure, and anything the evaluation cannot classify is treated as open, so an unfamiliar guard makes the sweep count rather than letting a named read pass as one. Parentheses, a prefix `!`, a type assertion, a loop-local `const` alias and a ternary are all handled by that evaluation rather than by a case per spelling.

This also fixes two silent false negatives, where a legitimate sweep stopped counting with nothing going red: a sweep whose entry is bound to a `const` before being read, and a sweep filtered through a helper or shadowed binding named `String`.

Refs #1575
