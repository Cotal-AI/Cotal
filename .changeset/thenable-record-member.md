---
"@cotal-ai/lang": patch
---

A record may not carry a callable `then`, and the run that tries to build one now refuses it with L4021 instead of dying.

To the host's promise machinery any object with a callable `then` is a thenable, and resolving a promise with one calls the record's own `then` instead of delivering the value. Inside the interpreter every function is async, so a program-authored `then` that throws turned that throw into the rejection of a promise nobody owns: it escaped `run()` as an unhandled rejection and killed the host process, while the await that adopted the record never settled and the run hung behind it with its journal and its lease. Measured live before the fix: a program returning `{ then: () => { throw { code: "stray-then" } } }` from a function left the host dead with an unowned rejection and `run()` forever pending.

The refusal is at the write, on every route that can put a member on a record: a literal key or a computed one, in an object literal, a spread, a rest pattern, or a member assignment. No thenable value ever exists for the machinery to adopt, on any path, the same way the language carries no sparse arrays and no `__proto__` fields. A `then` that is not callable is untouched data, and functions under any other member name are unaffected. The spec's record rules (§4.3), its error catalog, and its change log carry the rule in the same change.
