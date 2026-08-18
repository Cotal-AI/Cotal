---
"@cotal-ai/lang": minor
---

The pure fragment of cotal-lang is JavaScript, and the run's outcomes are decided by recorded facts.

One syntax table now drives both the validator and the interpreter, so every construct the language
admits executes and every one it refuses carries a code with a fix: compound assignment (`+=`, which
had behaved as `=`), `++`/`--`, `**` and the bitwise operators, optional chaining, rest parameters,
logical assignment, `undefined` as a nameable value, per-iteration `for (let …)` bindings, braced
`switch` cases; `==`, the comma operator, `void`, `__proto__` and syntax outside the table are
refused statically. Member access reaches no host prototype: records answer their own fields, arrays,
strings and numbers answer a curated method table with JavaScript's meaning (`xs.map`, `s.trim()`,
`n.toFixed()`, the array mutators), and `sort` and `json` are declared. Records and arrays a program
builds are writable by the frame that built them and freeze when they cross an effect boundary
(L2031); a value born outside a concurrent branch cannot be written inside it, through any alias
(L2032). An effect input with no canonical form is refused at the boundary before any entry is
written (L3041, L3042 for a function). A workflow's `catch` now never sees a divergence or a
migration walk's refusal, alongside the cancellation, refused append and host release it already
could not see. `xs.length = n` truncates as in JavaScript; a longer length is L4017 (holes are not a
value here). The never-built names `any` and `all` are no longer reserved. Host errors from builtins
are L4016.

The binding, selection and completion rules are JavaScript's too. A `let`/`const` binds its whole
block: a straight-line reference above the declaration is refused when the program is read (L2004,
the temporal dead zone made static), a closure over a later binding stays legal and finds the dead
zone at run time only if called early, parameters bind left to right so a default sees only the
parameters before it, and a named function expression binds its own name inside itself. `default`
written above a matching case no longer shadows it, and a `finally` completion (return, break,
throw) replaces the try's or catch's — while an uncatchable fault (divergence, refused append,
release, cancellation, walk refusal) now unwinds past `finally` too, so cleanup can neither act on
nor replace a fault the program was never allowed to see. Bigint literals are refused (L1030).

Values do not coerce through the host and methods are not values: a record, array or function where
a primitive is needed (`+`, comparisons, unary `-`/`+`/`~`, `${...}`) is L4018 instead of the
host's ToPrimitive machinery, an array index write past the end is L4019 instead of a hole (at the
length it appends), and a bare method read (`xs.map` without the call) is L4020 — a method is
looked up at the call. The curated methods keep their namesakes' meaning under mutation (the length
is captured before the first callback) and in replacement strings (`$&` and friends mean what
JavaScript says); `sort`'s order is genuinely total (kinds rank, NaN after every number);
`json.stringify` refuses a value with no canonical form instead of silently dropping or nulling it,
and `json.parse` refuses a `"__proto__"` key exactly as the literal does (L4016).

Freeze-on-share holds at the share, in both directions: every admitted effect argument is deep-
frozen when it is dispatched, and a journal seeded from serialized entries freezes them on the way
in, so a replayed result is as immutable as the live one was. The crossing boundary refuses a
sparse array's holes, a cycle, and a minted own `__proto__` field by name (diamonds still cross).

And a scope's clock survives resume: the scope entry is stamped with the joined branch clock at
settle — the value `now()` answers after the scope, live — so a resume answers the same `now()` and
takes the same path. A cancelled race arm whose in-flight effect lands past the settled frontier is
cut there instead of burning the step budget on a verdict from its old clock (an arm landing before
the frontier can still win), and a cancellation that arrives while an effect's `begin` append is in
flight settles the pending entry cancelled and never dispatches the handler.

A live `race` is decided by the arms' recorded clocks and declaration order and never by the
scheduler: a loser is cut short in pure work only once it can no longer win, so no `yieldEvery` value
selects the winner. Two new suites hold this: `semantics.smoke` runs the same pure programs on the
interpreter and on node and requires identical output, and `surface.smoke` holds the syntax table
and the library tables to the implementation, and validates every example in the language reference
and the guide when those files are present.
