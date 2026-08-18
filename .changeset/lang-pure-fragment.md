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
written (L3041, L3042 for a function), and a workflow's `catch` never sees a divergence, a
cancellation, a refused journal append or a host release. Host errors from builtins are L4016.

A live `race` is decided by the arms' recorded clocks and declaration order and never by the
scheduler: a loser is cut short in pure work only once it can no longer win, so no `yieldEvery` value
selects the winner. Two new suites hold this: `semantics.smoke` runs the same pure programs on the
interpreter and on node and requires identical output, and `surface.smoke` holds the syntax table,
the library tables and the language reference's examples to the implementation.
