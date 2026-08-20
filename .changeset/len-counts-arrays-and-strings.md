---
"@cotal-ai/lang": patch
---

`len` counts an array or a string and refuses every other kind in the language, so a function's host arity can no longer leak into a program value.

The builtin read `.length` off whatever it was handed. For a function that is the host's `Function.length`, and inside the interpreter it is the arity of the implementation's own wrapper: measured live before the fix, `len` of a program function answered 2 whatever parameters it declared, `len` of a builtin answered 0, `len` of a record, a number or a boolean silently answered undefined, and `len(null)` surfaced the host's TypeError text. A host-object internal was crossing into program values, against the language's determinism invariant: there is no ambient host property a program should reach.

`len` now accepts exactly the value kinds that have a length of their own, an array's elements and a string's units, and refuses every other kind with L4016 in the language, before the host is reached: no host property is read, no host error text appears, and the refusal is catchable. For a record's size, `len(keys(r))`. The spec's library-failure section and its change log carry the rule in the same change.
