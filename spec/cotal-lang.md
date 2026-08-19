# Cotal Lang: the workflow language

> **Status:** Draft, language version `2`, companion to [SPEC.md](../SPEC.md) §14 (v0.5). Version
> `1` is the tree-walker and stays supported: it is the replay engine for every run recorded
> under it, and §8.4 says what the two versions differ on. This
> document is the normative reference for the language a Cotal workflow run executes: what a
> program may say, what it means, and what it writes into the step journal. SPEC.md §14 defines
> the wire the journal and the run record travel on; this document defines their content and the
> program that produces it. Where the reference implementation (`@cotal-ai/lang`) disagrees with
> this document, this document wins.
>
> The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in RFC 2119 and RFC 8174.
> Every ```` ```js ```` block in this document is a program the validator accepts as written, or a
> refusal whose first line names the code it produces (`// refused: L1001`); the reference
> implementation's surface suite executes that claim.

## 1. Scope

A **program** is one source text. A **run** is one execution of a program under a **pin set**
(§8.3), identified by a run id the driver mints. A run performs **effects** through a small set of
primitives (§6); everything else a program does is **pure** and is ordinary JavaScript (§2). Every
effect writes an entry into the run's **step journal** (§10), keyed by where in the program it
happened rather than when, and a run can be re-executed from that journal on any host: recorded
effects return their recorded results and unrecorded ones are performed (§11).

Three properties hold by construction, and every rule below serves one of them:

- **Determinism.** Two executions of one program under one pin set that observe the same effect
  results reach the same next effect with the same inputs. There is no ambient clock, randomness,
  IO, or host object a program can reach.
- **Immutability at the boundary.** A value that crosses an effect boundary in either direction is
  what the journal recorded, and it cannot change afterwards.
- **Legibility.** Every refusal, static or at run time, carries a stable code (`Lnnnn`), the cause,
  and the edit that fixes it, in the coordinates of the author's source. The catalog is Appendix A.

The audience of this document is an implementer of the language or of a tool that reads its
journal, and the author of a program, who is usually a language model.

## 2. Programs and syntax

### 2.1 A program is one module

A program is parsed as an ECMAScript 2023 **module** (strict mode; top-level `await` is allowed and
is how a program performs its first effect). It MUST NOT import or export (L1020): a run pins to
the content hash of exactly this text, so there is no second file. Its **program hash** is
`sha256:<hex>` over the RFC 8785 canonical form of `{ "source": <the text> }`.

Automatic semicolon insertion is allowed. The two constructs where a newline changes what a program
means are refused (L1008): a value on the line after a bare `return`, and a line opening with `(`
or `[` that continues the statement above it.

### 2.2 The syntax table

The language is a subset of JavaScript defined by a table of AST node types, and every admitted
construct means what ECMAScript says it means, with the exceptions §3 to §5 name explicitly. An
implementation MUST accept exactly the admitted set and MUST refuse everything else with the code
the table gives, or with L1029 for syntax the table does not name.

**Admitted statements:** program, expression statement, `const`/`let` declaration, `function`
declaration, block, `if`, `while`, `for`, `for...of`, `return`, `break`, `continue`, `throw`,
`try`/`catch`/`finally`, `switch`, empty statement.

**Admitted expressions:** literal (string, number, boolean, `null`; not regex, not bigint),
identifier,
template literal, array literal, object literal (with spread), member access (`.name`, `[expr]`),
optional chain (`?.`), unary (`!`, `-`, `+`, `~`, `typeof`), update (`++`, `--`), binary (`===`,
`!==`, `<`, `<=`, `>`, `>=`, `+`, `-`, `*`, `/`, `%`, `**`, `&`, `|`, `^`, `<<`, `>>`, `>>>`),
logical (`&&`, `||`, `??`), conditional (`?:`), assignment (`=`, every compound form including
`&&=`, `||=`, `??=`, and destructuring targets), `await`, arrow function, function expression, call
(with spread arguments).

**Structural (inside an admitted node):** declarator, property, spread element, rest element,
default value, object and array patterns, template element, switch case, catch clause.

**Refused, with the code and the repair:**

| Construct | Code | Instead |
| --- | --- | --- |
| `class`, `this`, `new`, `super` | L1001, L1002, L1019 | records and functions |
| `var` | L1003 | `const`, or `let` when reassigned |
| `for...in`, the `in` operator | L1004 | `for (const k of keys(record))`, `has(record, key)` |
| generators, `yield` | L1005 | a loop with `await` inside it |
| regular expression literal | L1007 | `contains`, `startsWith`, `endsWith`, `split` |
| unbraced `if`/loop body | L1009 | braces |
| `switch` case that falls through | L1010 | end each case with `return`, `break`, `continue` or `throw` |
| computed property key `{ [k]: v }` | L1011 | a literal key, `merge`, or `record[k] = v` |
| array elision `[1, , 3]` | L1012 | write the value, or `null` |
| `with` | L1013 | none |
| getters and setters | L1015 | store the value, or call a function |
| `instanceof` | L1016 | compare a field |
| labels, labelled `break`/`continue` | L1017 | a helper function or a flag |
| tagged template | L1018 | a plain template literal |
| `import`, `export`, `import()`, `import.meta`, `new.target` | L1020 | one file; `run()` for run metadata |
| `delete` | L1021 | build a new record |
| `do...while` | L1022 | `while` or `for` |
| `await` in a non-async function | L1023 | mark the function `async` |
| top-level `return` | L1024 | `log(...)`, or publish the result through an effect |
| `==`, `!=` | L1025 | `===`, `!==`, `?? `, `=== null` |
| comma operator | L1026 | one statement per expression |
| `void` | L1027 | `undefined`, or drop the expression |
| the property name `__proto__` | L1028 | another name |
| bigint literal (`10n`) | L1030 | a number, or a string |
| `debugger`, and any other syntax | L1029 | none |

`eval`, `Function` and `Symbol` are host globals and are refused by name (L2012, §3); no module
syntax reaches L1006 or L1014, which stay reserved.

```js
// refused: L1001
class Plan { constructor(days) { this.days = days } }
```

```js
// refused: L1025
const same = 0 == ""
```

### 2.3 Static rules beyond syntax

The validator MUST also refuse, before a program runs:

- An identifier that is not declared in the program and is not a reserved name (L2001); a host
  global by name (L2012, with the language's replacement in the fix, §3); the name `Promise` (L2011).
- A declaration, parameter or function name that shadows a reserved name (L2002); an assignment
  to a `const` binding (L2003).
- **A reference to a `let`/`const` binding above its declaration (L2004, the dead zone; §3)**, where
  straight-line code makes it visible. A reference from inside a nested function is not refused —
  the function may run after the declaration — and the same refusal moves to run time when the call
  comes first.
- **A call that starts an effect and is not awaited (L2013).** A call to an effect primitive, or to
  a user function declared `async` (or bound by `const` to an async function expression), MUST be
  the operand of `await`, the operand of `return`, or the concise body of an arrow function passed
  as a branch to `parallel`, `race`, `fanOut` or `conclave`. Anything else starts work whose result
  nothing waits for, and calls outside a combinator run in sequence, so the program would say
  "concurrently" while the runtime did the opposite. The validator enforces this where the call
  site is syntactically visible; an effect reached through a function value it cannot follow (an
  arrow passed to a user function that calls it without awaiting) is not refused, and the program
  is responsible for awaiting it.
- The effect call-shape rules of §6.2 and §6.3 (L3011 to L3044).
- **A write from a concurrent branch to a binding declared outside it (L2032, §7.7).**

```js
// refused: L2013
async function work(n) { return await sleep("1m") }
const pa = work(1)
const pb = work(2)
```

Warnings (returned, never blocking): array-form `parallel`/`race` branches (L3023, keyed by index),
and a `fanOut` over a literal list whose items carry no `id` and no `key` (L3021).

## 3. Names

A program may reference, and MUST NOT redeclare, the **reserved names**: the primitives (§6),
the event constructors (`replied`, `message`, `idle`, `down`), the pure primitives (`channel`,
`run`), the builtins (§5.1), and the value `undefined`. Every other name
a program uses it declares. Name resolution is lexical and static: `let`/`const` are block-scoped
and bind their whole block — a reference above the declaration is the dead zone, refused when the
program is read where straight-line code makes it visible and at run time otherwise (L2004, §2.3);
`function` declarations are hoisted within their block and bind immutably (assignment is L2003); a
named function expression binds its own name inside its own body, and nowhere else; parameters bind
left to right, so a default value reaches only the parameters before it (L2004 past that);
`for (let ...)` binds per iteration; and a `catch` parameter is `const`.

The following host globals are refused by name (L2012), each with the replacement this language
offers: `Math`, `JSON`, `Object`, `Array`, `Number`, `String`, `Boolean`, `parseInt`,
`parseFloat`, `isNaN`, `isFinite`, `Infinity`, `NaN`, `Date`, `Map`, `Set`, `Error`, `console`,
`setTimeout`, `setInterval`; and without a replacement: `globalThis`, `global`, `window`, `self`,
`process`, `fetch`, `RegExp`, `Reflect`, `Proxy`, `Symbol`, `WeakMap`, `WeakSet`, `WeakRef`,
`Function`, `setImmediate`, `queueMicrotask`, `require`, `module`, `exports`, `__dirname`,
`__filename`, `Buffer`, `crypto`, `performance`, `structuredClone`, `eval`, `arguments`, `BigInt`,
`Intl`, `Atomics`, `SharedArrayBuffer`, `ArrayBuffer`, `DataView`, `TextEncoder`, `TextDecoder`,
`URL`, `URLSearchParams`, `AbortController`, `encodeURIComponent`, `decodeURIComponent`,
`encodeURI`, `decodeURI`, `escape`, `unescape`, and the typed array constructors.

## 4. Values

### 4.1 Kinds

A value is one of: `null`; a boolean; a number (an IEEE 754 double); a string; an **array**; a
**record** (an object literal: own string-keyed fields, no prototype a program can reach); a
**function** (a closure the program wrote, or a builtin); or `undefined`, which the runtime produces
for a missing field, an out-of-range index, and a function that returns nothing, and which a
program can name and test for but which cannot cross an effect boundary (§4.4).

The runtime additionally mints **handles** and **descriptors**, all frozen records:

| Value | Shape |
| --- | --- |
| agent handle (from `spawn`) | `{ agent, persona, worktree?, role? }`; `agent` is the agent's stable identity, never a session or host pointer |
| channel handle (from `channel`, `conclave`) | `{ channel }` |
| event descriptor (§6.6) | `{ event: "replied", agent }` \| `{ event: "message", channel, from?, matches? }` \| `{ event: "idle", channel, duration }` \| `{ event: "down", agent }` |
| run metadata (from `run()`) | `{ id, programHash, startedAt }` |

### 4.2 Members

Member access reaches no host prototype. A **record** answers its own fields and `undefined` for
any other name (`o.constructor`, `o.toString`, `o.hasOwnProperty` are `undefined`). An **array**
answers an index, `length`, and the array method table (§5.2). A **string** answers an index,
`length`, and the string method table. A **number** answers the number method table. Any other
member of an array, string or number is a refusal naming the table (L4014). Reading a member of
`null` or `undefined` is L4010; a function or a boolean has no members (L4014). Iteration
(`for...of`, spread) accepts an array or a string and nothing else (L4015). Calling a value that is
not a function is L4011. A method is not a value: reading a method name off an array, string or
number without calling it is refused (L4020) — write `(x) => xs.includes(x)`, not `xs.includes`.
Destructuring follows member access: `const { a } = v` reads `a` as a member of `v`, so
destructuring `null` or `undefined` is L4010 and a primitive answers from its method table (L4014
for a name that is not there), never by ECMAScript's object coercion. A computed key must be a
primitive: `o[1]` and `o[true]` spell as JavaScript spells them, and an array, record or function
key is refused (L4018, §4.5) before any conversion — ECMAScript would pass it through `toString`
and address a field named `"[object Object]"` the program never wrote.

### 4.3 Mutation and freezing

A record or array the program builds is **writable by the frame that built it**: member assignment
(`o.a = v`, `xs[i] = v`), update (`o.n++`), compound assignment, and the mutating array methods
(`push`, `pop`, `shift`, `unshift`, `splice`) are ordinary JavaScript. `xs.length = n` truncates as
in JavaScript, and only truncates: `n` MUST be an integer between 0 and the current length, because a
longer length would create holes, a value class this language does not have (its methods do not skip
holes, so a program with holes would read differently here and on a real engine); anything else is
L4017. An index write is contiguous for the same reason: `xs[i] = v` takes an index up to and
including `xs.length` — writing at `length` appends — and a write past the end is refused (L4019).
Two writes are refused:

- **L2031, a frozen value.** Every value that crosses an effect boundary in either direction is
  deep-frozen: an effect's arguments, its result, and the result of a concurrency scope. What
  crossed is what the journal recorded, so it cannot change afterwards — through a store too: a
  journal seeded from serialized entries freezes each recorded value on the way in, so a result
  replayed on resume is as frozen as it was live. Build a new value instead
  (`{ ...record, field: value }`, `[...list, item]`).
- **L2032, a value born outside a concurrent branch and written inside it** (§7.7), whether it is
  reached through its binding or through an alias.

Records take any own field name except `__proto__` (L4014) and a callable `then` (L4021); arrays
take an index or `length` (L4014). A record literal, a spread, and a rest pattern always define
**own** fields. The `then` refusal holds wherever a record member is written, on a literal key or
a computed one, in a literal, a spread, a rest pattern, or a member assignment: an object with a
callable `then` is a thenable, which the host's promise machinery would adopt in place of the
value the program built, its `then` running with the machinery's own continuations while one that
throws or rejects escapes the run as an unowned rejection. The language carries no thenable values
at all; a `then` that is not callable is data like any other member.

### 4.4 Canonical form, and what may cross an effect boundary

The **canonical form** of a value is its RFC 8785 (JCS) serialization. A value MAY cross an effect
boundary only if it has one: `null`, a boolean, a **finite** number, a string, and arrays and
records of these. `undefined`, `NaN`, `Infinity`, functions, and objects that are not plain records
have no canonical form. An implementation MUST refuse such a value in any argument of an effect
primitive **before any journal entry is written**, naming the argument and the path inside it:
L3041 for `undefined`, a non-finite number or an opaque object, L3042 for a function. A sparse
array (a hole), a cyclic value, and a record carrying an own `__proto__` field are refused the same
way: a hole would canonicalize into a `null` the program never wrote, and a cycle does not
serialize. A shared subtree without a cycle (a diamond) crosses. An effect
**result** that has no canonical form is a failed step: the entry settles `failed` with error
`{ code: "L4000", kind: "handler-fault" }` and the failure is thrown to the program.

`json.stringify(value)` is the canonical form (§5.1), so a program that serializes a value writes
exactly what the journal would — and is refused (L4016) exactly where the boundary would refuse.

### 4.5 Operators and equality

Only strict equality exists (`===`, `!==`; §2.2 refuses `==`). On **primitives** every arithmetic,
bitwise, comparison and logical operator has its ECMAScript meaning, including coercion (`"a" + 1`
is `"a1"`, `+"3"` is `3`); a program that wants a number from text uses `parseNumber`. An array, a
record or a function never coerces: the arithmetic, bitwise and ordering operators, unary `-`, `+`
and `~`, template interpolation, a computed member key (`o[k]`, read or written), and a builtin or
method parameter that takes a primitive (§5.4) refuse such an operand (L4018), because ECMAScript's
answer would pass through a `toString` this language does not give its values. `===`/`!==` (identity),
`!`, `typeof` and the logical operators take every value. `??` is the recovery operator: `wait`
resolves `null` on timeout (§6.5), so `await wait(...) ?? fallback` reads as Orc's `otherwise`.

### 4.6 Durations

A duration is a string of a whole number and one unit: `ms`, `s`, `m`, `h`, `d` (`"30s"`, `"10m"`,
`"4h"`, `"2d"`). Nothing else parses; there is no bare number and no default unit. `duration(text)`
converts one to milliseconds.

## 5. The library

The library is small and closed. Nothing in it reaches a host object; every function has the
meaning JavaScript gives its namesake, so a pure program produces the same output here and on a
JavaScript engine with these functions injected (the reference implementation's differential suite
runs exactly that comparison).

### 5.1 Builtins

Free functions, declared as immutable bindings. Callback-taking builtins call the callback **one
element at a time and await each call**, in order; a callback may perform an effect, and a program
that wants concurrency says so with `parallel` or `fanOut` (§7).

| Group | Builtins |
| --- | --- |
| records | `keys(r)`, `values(r)`, `entries(r)`, `has(r, key)` (own fields only), `merge(a, b)` |
| arrays | `len(xs)`, `map(xs, f)`, `filter(xs, f)`, `find(xs, f)` (→ `null` when absent), `some(xs, f)`, `every(xs, f)`, `sort(xs, keyFn?)`, `slice(xs, start, end?)`, `concat(xs, ys)`, `join(xs, sep)`, `reverse(xs)`, `unique(xs)`, `range(n)`, `sum(xs)` |
| strings | `split(s, sep)`, `trim(s)`, `lower(s)`, `upper(s)`, `startsWith(s, p)`, `endsWith(s, p)`, `contains(s, p)`, `replace(s, from, to)` (**every** occurrence) |
| numbers | `min(...xs)`, `max(...xs)`, `abs(n)`, `floor(n)`, `ceil(n)`, `round(n)`, `parseNumber(text)` (`Number(text)`) |
| data and control | `json.parse(text)` (refuses a `"__proto__"` key, L4016), `json.stringify(value)` (the RFC 8785 canonical form; a value that cannot cross an effect boundary cannot stringify, L4016), `assert(cond, message?)` (L4012 when false), `log(...values)` |
| tamed nondeterminism | `random()`, `randomInt(n)`, `pick(xs)` (§8.2), `now()` (§8.1), `duration(text)` (§4.6) |

`f` in `map`, `filter`, `find`, `some`, `every` receives `(item, index)`. `sort` returns a new
array ordered by a **total order** (§5.3) over `keyFn(item, index)` when given, else over the
items; a returned array or record is a fresh value the calling frame owns. `log` is not journalled,
and a `log` that succeeds MUST NOT influence control flow: it exists for a human reading the trace,
and each line carries the scope path it was written from. A `log` that is *refused* is a refusal
like any other, which under version `2` is a case a program can meet: uncaught it ends the run, and
caught it skips the rest of its `try`. Under version `1` no `log` refuses, so the question does not
arise there.

Under language version `2`, `log` is **data**, and the rule is about code rather than about
crossing: a function anywhere inside a logged value is refused with L4016 (§8.4), naming the value
and the path, whether it arrives as the argument itself, inside a record, or as a namespace.
Everything else a program can build reaches the trace as it is, `undefined` and the non-finite
numbers included, because the trace is not the journal and a human wants to see them. This is
deliberately **not** the effect-crossing rule of §4.4, which refuses those same values and which
`json.stringify` does apply. Version `1` prints what it is given. This is one of the differences a
version exists to separate, and it is why a log line written by one engine is not a log line the
other would have written.

### 5.2 Methods

| Receiver | Methods |
| --- | --- |
| array | `map`, `filter`, `find`, `findIndex`, `findLast`, `findLastIndex`, `some`, `every`, `forEach`, `reduce`, `flatMap` (callbacks awaited in order, receiving `(item, index, array)`); `includes`, `indexOf`, `lastIndexOf`, `slice`, `concat`, `join`, `flat`, `at`, `toReversed`; the mutators `push`, `pop`, `shift`, `unshift`, `splice` (§4.3) |
| string | `trim`, `trimStart`, `trimEnd`, `toLowerCase`, `toUpperCase`, `startsWith`, `endsWith`, `includes`, `indexOf`, `lastIndexOf`, `slice`, `substring`, `split`, `replace` (first occurrence), `replaceAll`, `repeat`, `padStart`, `padEnd`, `at`, `charAt`, `concat` |
| number | `toFixed`, `toString`, `toPrecision` |

Every pattern argument (`split`, `replace`, `startsWith`, ...) is a string; there are no regular
expressions. Note the two places the free builtin and the method deliberately differ: `find(xs,
f)` yields `null` where `xs.find(f)` yields `undefined`, and `replace(s, a, b)` replaces every
occurrence where `s.replace(a, b)` replaces the first, in each case exactly as JavaScript spells the
method. The string `replace` and `replaceAll` methods honour JavaScript's replacement patterns
(`$$`, `$&`, `` $` ``, `$'`): the replacement is a string with ECMAScript's substitution, not a
template. Callback methods read the array's length once, before the first call, as JavaScript's do,
so a callback that pushes does not extend its own iteration. And a method is looked up at the call,
never read as a value (L4020, §4.2).

### 5.3 The total order

`sort` never answers "equal" for two distinct values, and answers consistently in both directions.
Values order by kind — `undefined`, then `null`, `false`, `true`, numbers, strings, arrays,
records — and within a kind numbers compare by value with `NaN` after every number, strings by code
unit, and arrays and records by canonical form. A tie on the key falls to the canonical form of the
elements themselves and then to their original position. What is left equal is identical, so the
result of `sort` is a function of its input alone.

### 5.4 Library failures

A builtin or method given inputs the host refuses (`"a".repeat(-1)`, `json.parse("{")`, `[].reduce(f)`)
raises L4016 naming the builtin; the host's own error class and stack never reach the program.
`assert` raises L4012 with the message.

Where a parameter takes a **primitive**, an array, record or function in that position is refused
(L4018) before any host conversion — the operators' rule (§4.5) at the library boundary — and this
includes each element `join` and `sum` would stringify or add, and `assert`'s message. The positions
that take a container or a function by contract (a callback, a list or record argument, a search
value compared by identity, `log`'s values, `json.stringify`'s value) are not refused there: L4018
is a rule about the position, and a value position takes a value, primitive or not. What a
position accepts past that point is its own rule rather than the group's: `log`'s values pass no
further check under version `1` and must carry no code under version `2` (L4016, §8.4);
`json.stringify`'s value must satisfy the effect-crossing rule of §4.4 at both versions (L4016),
which refuses the `undefined` and non-finite values `log` accepts.

## 6. Effects

An **effect** is a call to one of the primitives below. Every effect is journalled (§10) under a
**step key** allocated at the call, its **inputs are hashed** (§6.4), and its result is what the
journal recorded. `channel()` and `run()` are pure primitives: they build a value and write nothing.

### 6.1 The primitives

| Primitive | Signature | Journal kind | Name |
| --- | --- | --- | --- |
| `spawn` | `spawn(persona, { name?, worktree?, join?, role?, permits?, supervise?, onFork? }) -> AgentHandle` | `spawn` | `name`, else the persona |
| `turn` | `turn(agent, { name, deadline? }) -> { status, to?, note?, at }` | `turn` | required |
| `ask` | `ask(agent, { name, schema, deadline?, attempts? }) -> record` | `ask` | required |
| `checkpoint` | `checkpoint(name, prompt, { schema?, timeout?, onExpiry?, to? }) -> { status, value?, by?, at, artifact? }` | `checkpoint` | required, positional |
| `sleep` | `sleep(duration, { name? }) -> null` | `sleep` | optional |
| `wait` | `wait(event, { name?, timeout? }) -> value \| null` | `wait` | optional |
| `notify` | `notify(agents, fact, { name? }) -> null` | `notify` | optional |
| `monitor` | `monitor(agent, { name? }) -> null` | `monitor` | optional |
| `parallel` | `parallel(branches, { name? }) -> results` | scope `parallel` | optional |
| `race` | `race(branches, { name? }) -> { index, value }` | scope `race` | optional |
| `fanOut` | `fanOut(items, fn, { name, key? }) -> results` | scope `fanOut` | required |
| `conclave` | `conclave(members, fn, { name, channel? }) -> result` | scope `conclave` | required |

`persona` in `spawn` is a persona name, or a record `{ persona, model?, variant? }`.

### 6.2 Step names

A step name is a **kebab-case token of 1 to 64 characters** (`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`,
L3014). Where the table says *required*, the name MUST be present (L3012) and MUST be a string
literal (L3013), because the derived flowchart, the linter and the migration report all read it
without running the program. Where it is optional it MAY be computed (a `fanOut` naming each
branch's step after its item is the idiom), and a computed name is checked when the key is minted.
No name and no branch key may contain `/`, `#` or `:` (L3025): keys are built by concatenation
(§10.2), so such a value would forge a scope path.

### 6.3 Option bags

Every option bag sits at a **fixed argument position** (`checkpoint` and `notify` take theirs
third, `fanOut` and `conclave` third, every other primitive second) and is **closed**: a key not in
the signature is L3011, answered with the full signature. `to` on a `checkpoint` is legal only with
`onExpiry: "escalate"` (L3044).

### 6.4 What is hashed

Each effect's **input hash** is `sha256:<hex>` over the canonical form of the projection below,
which is exactly the set of inputs that decide whether a recorded result is still an answer to the
question the program is asking. Everything else steers live execution and is reapplied from current
source on a resume. An implementation MUST hash exactly these fields (an absent option is `null`; an
absent `join` is `[]`); the reference implementation's option suite edits each one on a resumed run
and requires exactly these to diverge (§11.1).

| Effect | Projection |
| --- | --- |
| `spawn` | `{ persona, model, variant, worktree, role, join: [channel names] }` |
| `turn` | `{ agent, deadline }` |
| `ask` | `{ agent, schema, deadline, attempts }` |
| `checkpoint` | `{ prompt, schema, timeout }`, plus `{ onExpiry: "escalate", to }` when and only when `onExpiry` is `"escalate"` |
| `sleep` | `{ duration }` |
| `wait` | `{ event, timeout }` |
| `notify` | `{ agents: [agent ids], fact }` |
| `monitor` | `{ agent }` |
| `parallel`, `race`, `fanOut` | `{ kind, name }` |
| `conclave` | `{ kind, name, subject: { members: [agent ids], channel } }` |

Two rules in that table are deliberate. `deadline`, `timeout` and `attempts` **stop observation**: a
`wait` that returned `null` observed "not within this timeout", never "never", so an edited timeout
asks a different question. And `onExpiry` is hashed **only** at `escalate`, because `fail` and
`proceed` choose how to read a recorded expiry (a reapply that MUST replay clean) while `escalate`
mints a second effect (a different question that MUST diverge). `permits`, `supervise` and `onFork`
on `spawn` are policy over a result and are never hashed.

### 6.5 Semantics of each primitive

- **`spawn`** brings an agent into the run and returns its handle. `permits` are budgets whose
  violation the handler reports as a catchable failure (L4001); `supervise` is a declarative
  restart policy; `onFork` is `"respawn"` (default) or `"adopt"` (§11.3). Two agents MUST NOT share
  a worktree concurrently (L3022, L4008).
- **`turn`** wakes an agent for one turn; it reads its own channels and speaks for itself. The
  result is its yield status: `done`, `blocked`, or `handoff` (with `to`), and `at`. The handler
  reports a handoff to an agent outside the run as L4005, one across worktrees as L4004, an elapsed
  `deadline` as L4003, and a dead agent as L4002. The language does not refuse two concurrent turns
  on one handle (two branches turning the same agent); whether they are serialized or refused is the
  handler's, and the reference handlers do neither in this revision.
- **`ask`** is the narrow case where the program needs a value: the agent publishes a record, the
  program awaits it, and the handler checks it against `schema`; `attempts` bounds how many
  non-conforming replies are tolerated before the handler reports L4006. `schema` (here and on
  `checkpoint`) is an opaque record to the language: it is canonicalized into the input hash and
  handed to the handler unchanged, and its meaning is the handler's. No handler in the reference
  implementation interprets it in this revision (the simulator and the mesh handler accept any
  value), so a program MUST NOT rely on a shape being enforced.
- **`checkpoint`** is a durable pause a human or an agent resolves from anywhere, raced against a
  durable timer. The handler reports the **raw** outcome, `resolved` (`value?`, `by?`, `artifact?`,
  `answerId?`, `at`) or `expired` (`at`); the journal holds that outcome plus the interpreter's
  `attempts` chain, `[{ attempt, requestId, to?, settled }]`, one row per mint under the entry, so
  an escalation's second identity is in the record and a recovery completes the open attempt rather
  than re-running the chain; the **disposition** is
  computed from the current source afterwards, on the live and the replay path alike: `fail`
  (default) throws L4007, `proceed` returns `{ status: "expired", at }`, `escalate` mints exactly one
  further checkpoint addressed to `to` under the same entry (a second attempt with its own request
  id, §10.4) and, if that expires too, returns `{ status: "expired", at }`. There is never a third
  hop.
- **`sleep`** is a durable timer; a resumed run does not re-sleep an elapsed sleep. It fails at the
  call, not in the handler, on a malformed duration.
- **`wait`** awaits one event (§6.6) and resolves `null` on timeout rather than throwing.
- **`notify`** tells agents about a branch decision. It writes a **notice** onto the run, rendered
  ahead of each addressee's next turn; it is never a channel message. The fact is bounded (§6.8).
- **`monitor`** registers interest in an agent's health, after which `down(agent)` is an event a
  branch can `wait` on.
- The four scopes are §7.

### 6.6 Events

Event constructors are pure; they build a descriptor and `wait` observes it: `replied(agent)` (the
agent finished a reply), `message(channel, { from?, matches? })` (a message landed on the channel,
optionally filtered by sender or content), `idle(channel, duration)` (the channel went quiet for
the duration), `down(agent)` (a monitored agent died; the value carries the reason).

### 6.7 Pure primitives

`channel(name)` names a channel and returns its handle; a name is a name and membership is what
costs something. `run()` returns this run's `{ id, programHash, startedAt }`.

### 6.8 The `notify` bound

`notify` is the only primitive that moves program-authored bytes toward an agent's context, so its
fact is a **bounded decision record**, checked exactly on a literal fact by the validator and by the
same rules at the effect boundary on a computed one (L3043), and never truncated: `decision` and
`outcome` are step-name tokens (§6.2); `detail`, if present, is a record of at most 8 keys, each key
a kebab-case token of at most 32 characters, each value a finite number, a boolean, or a single-line
string of at most 128 characters (no control characters or line separators). Nothing else may
appear.

```js
const planner = await spawn("planner")
const builder = await spawn("builder", { worktree: "wt-1" })
const r = await turn(builder, { name: "build", deadline: "30m" })
if (r.status === "blocked") {
  await notify([planner], { decision: "build", outcome: "blocked", detail: { note: r.note ?? "" } })
  await turn(planner, { name: "unblock" })
}
```

## 7. Concurrency

Concurrency is visible in the source: a program has no `Promise` and no way to start work it does
not await except through the four **scopes**. Each scope opens a **scope frame** in the step-key
grammar (§10.2), gives every branch its own key namespace, and writes one journal entry of its own
whose result records how it settled.

### 7.1 Branches and branch keys

`parallel` and `race` take their branches **unevaluated**, as a record of thunks (`{ lint: () =>
..., tests: () => ... }`) or an array of thunks; a branch runs in its own frame. Record keys are
the branch keys and survive reordering and insertion; array branches are keyed by their index (a
warning, L3023: inserting a branch shifts every later branch's namespace). `fanOut(items, fn, { key })`
runs `fn(item, index)` per item; the branch key is `key(item)`, else the item's string `id`, else
the fan-out is refused (L3021). Branch keys MUST be unique (L3024), and every key is computed before
any branch launches.

### 7.2 `parallel`

Runs every branch and settles all of them; the value is the results keyed as the branches were. The
first rejection cancels the rest (§7.6) and the scope fails with it. The scope's clock joins its
branches' clocks (§8.1).

### 7.3 `race`

Runs every branch and yields the **earliest** one as `{ index, value }`, where `index` is the branch
key. An arm's **logical settlement time** is its branch clock at settle: the greatest `endedAt` of
the effects it awaited, or the scope's entry clock if it awaited none (§8.1). The winner is the
settled arm with the least logical time; equal times fall to **declaration order**. A branch that
rejected with a failure is a candidate and wins by failing the scope; a branch that was cancelled
is not a candidate. Both facts are recorded, so a replay resolves the same arm regardless of
scheduling.

Live, no scheduler and no host tuning value chooses the winner. When an arm settles at logical time
*t*, every sibling is cancelled (it performs no new effect, §7.6), and a sibling is additionally cut
short in pure work only if it **can no longer win**: its clock is later than *t*, or equal and it is
declared later. A sibling that could still win runs its pure tail to a settle; a sibling that
reaches a new effect is cut there, having proven it would end after *t*. A later settle with an
earlier clock re-decides the cut for the rest. So does a landing: an effect a cancelled arm already
had in flight advances that arm's clock when it lands, and a landing that pushes the arm past the
frontier cuts its pure tail at the next yield — one that leaves it earlier lets it run on, still
able to win. The scope entry records the winner, the losers
(`cancel.losers`), and, when the branches are written as an object literal, a **branch digest** over
the losers' bodies (§10.6), so an edit inside an arm the walk never enters still diverges.

```js
const builder = await spawn("builder")
const outcome = await race({
  reply: () => wait(replied(builder), { timeout: "20m" }),
  giveUp: () => sleep("1h"),
}, { name: "await-or-move-on" })
if (outcome.index === "giveUp") {
  await notify([builder], { decision: "await-reply", outcome: "gave-up" })
}
```

### 7.4 `fanOut`

Runs `fn(item, index)` for every item concurrently and settles all of them; the value is the array
of results in item order. The first rejection cancels the rest (§7.6) and the scope fails with it,
carrying the losers, exactly as `parallel`. Its journal namespace per branch is the branch key, so a
reordered or filtered list keeps every recorded step where it was.

### 7.5 `conclave`

Opens a scoped sub-team: the handler creates (or names, with `channel`) a conclave channel, joins
`members`, `fn(channelHandle)` runs as the single branch `in`, and the members leave when it
returns. It is a scope **and** an effect: its one entry (kind `conclave`) hashes the members and
channel (§6.4) and carries a `closed` fact stating whether the membership was released (§10.6). A
body that merely fails is closed; a body that was cancelled is not, and its release travels the
recovery path of every other branch-local resource.

### 7.6 Cancellation

Cancellation is by semantics, never by an API the program calls, and it has one law on the program
side: **a cancelled branch performs no new effect** (the effect boundary raises the cancellation
instead of dispatching, and a pending entry it held settles `cancelled`). The boundary holds across
its own gap: a cancellation raised while the pending entry was being written is seen again after
the write, so the effect is still not dispatched and the entry settles `cancelled` — the signal
reaches a branch asynchronously, but from the moment it is raised no new effect starts. Work
already in flight is
the handler's: an agent reply already in progress completes and is ignored. A `catch` never sees a
cancellation (§9.2). A `race` may additionally cut a loser's pure work at a yield point once it can
no longer win (§7.3); a pure loop in an arm that could still win ends on the step budget (L4013).

### 7.7 Writes across branches

A branch MUST NOT write to a binding declared outside it (L2032; refused statically where the
branch is a function the validator can follow, and at run time in every case), and MUST NOT write
into a record or array **born** outside it, through any alias (L2032 at run time). Freezing does not
cover this: nothing crosses an effect boundary. And it is silent: live, branches write in completion
order; on resume the recorded effects return instantly and they write in launch order, so the run
takes a path it never recorded with no divergence to catch it. Return the value from the branch and
read it out of the scope's result. `conclave` has one branch and does not raise the depth.

```js
// refused: L2032
let winner = null
const a = await spawn("a")
const b = await spawn("b")
await parallel({
  first: async () => { const r = await turn(a, { name: "go" }); winner = r },
  second: async () => { const r = await turn(b, { name: "go" }); winner = r },
})
```

## 8. Determinism

### 8.1 Time

There is no wall clock. `now()` returns the calling branch's **run clock**: the greatest `endedAt`
over the effects that causally precede the call, that is, the ones this point actually awaited.
Sequentially that is the previous effect's end; a branch inherits its parent's clock when it forks;
joining branches takes the maximum; a branch never sees a sibling's completion it did not await.
The clock starts at the run's **logical epoch**, `startedAt`, and is deterministic under replay,
which is what makes "time advances only at effect boundaries" a property of the design rather than
a convention. A concurrency scope's own entry stamps its `endedAt` with the joined branch clock —
that same maximum, a cancelled arm's landings included — not the host clock at settle, so `now()`
after a scope answers the same value live and on resume (§10.1).

### 8.2 Randomness

`random()`, `randomInt(n)` and `pick(xs)` draw from a PRNG seeded per run and **derived per scope
path**: the *n*-th draw in scope *p* is the first 48 bits of the SHA-256 of the concatenation
`seed, U+0000, p, U+0000, n` (the UTF-8 bytes of the seed, ONE NUL BYTE, the scope path string of
§10.2, ONE NUL BYTE, and the decimal draw index; the separator is U+0000, not a space) divided by
2^48. Draws are never journalled: they are a pure function of the seed and the
scope, so an edit that adds a draw elsewhere in the program does not disturb this scope's sequence.

### 8.3 Pins

A run is not pinned by its source alone. The **pin set** is resolved once when the run starts,
recorded on the run record (SPEC.md §14), and read back on every resume; a resume that supplies a
different value for any pin is refused (L5009), and a resume handed history without pins is refused
(L5021).

| Pin | Meaning | Default |
| --- | --- | --- |
| `seed` | the PRNG seed (§8.2) | the run id |
| `startedAt` | the logical epoch, in ms; `now()` before the first effect | the host clock at start |
| `yieldEvery` | interpreter dispatches between yields to the host's event loop | 1024 |
| `stepBudget` | interpreter dispatches allowed in **one walk** before L4013 | 1 000 000 |
| `effectCeiling` | effects allowed in **the run** before L4009 | 10 000 |
| `languageVersion` | the language version the run started under | the version of the engine that resolves them |

`yieldEvery` selects no outcome (§7.3): it is pinned so a run record never churns, and a future
revision MAY drop it from the pin set. `stepBudget` bounds a walk and not the run because steps are
not recorded, and a **step is whatever the running engine counts** — a walker dispatch under
version 1, a transformed-site hit under version 2 — so the same budget does not buy the same
program two engines, and a recorded `stepBudget` is not comparable across versions; `effectCeiling` bounds the run because the journal records every dispatch, and a
resume counts the recorded distinct effect keys (excluding `conclave`, which is dispatched from the
scope walker) toward it.

### 8.4 Language version

The **language version** is bumped when a revision changes what a program means: the PRNG, a
builtin, numeric behaviour, or the scheduling of the walker. It is deliberately not the package
version.

There are two versions, and they are two languages rather than two speeds of one:

| Version | Engine | What differs |
| --- | --- | --- |
| `1` | the tree-walker | a step is one walker dispatch; `log` takes any value the walker can print |
| `2` | the compiled engine | a step is one transformed-site hit; `log` is **data** and refuses code (L4016) |

Version `1` is not deprecated and does not expire: a run recorded under it has nowhere else to go,
so the walker remains its replay engine for as long as its records exist.

The version is a property of the ENGINE that runs a program, not of this document. An engine MUST
stamp the pins it resolves with **its own** version and MUST compare a recorded version against
**its own**, never against a shared notion of "the current language" — an engine that stamped one
version and compared another would refuse its own records.

Two refusals divide the work, and the difference is what the operator does next:

- **L5008**, at the engine: this record was handed to an engine whose version differs. There is an
  engine that speaks it, so the repair is to run it there, or to fork (§11.3).
- **L5023**, at whatever dispatches to engines: no engine in this build serves the recorded
  version. There is nothing here to name, so the repair is a build that serves it, or a fork. The
  refusal MUST name both the version it met and the set it serves; "this build cannot" is only
  actionable if it says what it can.

A build MAY serve several versions at once. Which versions it serves is a fact about that build,
declared, and a fresh run MUST be stamped with the version of the engine that will actually execute
it — never with the newest version the build knows of, unless that is the one that will run it.

## 9. Errors

### 9.1 What a program can catch

`throw` and `try`/`catch`/`finally` are JavaScript's. A value the program throws arrives in `catch`
as itself. A failure the runtime raised arrives as a **frozen record**: an effect's failure as
`{ code, kind, message, detail? }` (the recorded `EntryError`, §10.1) and an interpreter fault as
`{ code, kind: "runtime", message }`. A program cannot construct an `Error`, so anything that is
one came from the runtime or the host and is delivered as `{ code: "L4000", kind: "host", message }`.
`finally` carries ECMAScript's completion semantics: a `return`, `break`, `continue` or `throw`
that completes the finalizer replaces whatever the `try` or `catch` was completing with.

```js
const builder = await spawn("builder")
try {
  await turn(builder, { name: "build", deadline: "10m" })
} catch (e) {
  if (e.code === "L4003") {
    await notify([builder], { decision: "build", outcome: "timed-out" })
  } else {
    throw e
  }
}
```

### 9.2 What a program cannot catch

A `catch` MUST NOT see, and an implementation MUST unwind the run through, five things that are not
the program's to handle: a **cancellation** (§7.6); a **journal append the store refused** (L5010:
the run has lost its ability to have a result, and effects performed past it would exist only in the
world); a **host release** (L5012: the driver stopped, the program did not); a **divergence**
(L5001, §11.1: the journal is saying this program is not the one that wrote it); and a **migration
walk's refusal to enter a scope** (L5022, or an unwalkable `conclave`). These unwind past `finally`
too: a finalizer neither runs on the way out nor replaces the fault, because none of the five
leaves the program a next step to take — a cancelled branch performs no new work, and a run that
has diverged, lost its journal or been released cannot be allowed one more effect on the way down.

### 9.3 Error rendering

Every static refusal is reported in user-program coordinates as `{ code, title, where: { file, line,
column, frame }, cause, fix, callee? }`, where `frame` is the offending line with a caret and
`callee`, present when the error is blamed on a call to a primitive, carries that primitive's
signature, doc and one working example. The validator collects every error before reporting.

## 10. The step journal

### 10.1 Entries

The journal is an append-only log of entries. An entry is JSON:

```text
{
  v: 1,
  seq,                 // append order, for reading only; matching never uses it
  run,                 // the run id
  scope,               // the scope path string (§10.2)
  kind,                // spawn | turn | ask | checkpoint | sleep | wait | notify | monitor
                       //   | parallel | race | fanOut | conclave
  name,                // the step name, "" when unnamed
  occurrence,          // the n-th (kind, name) in this scope, from 0
  inputHash,           // "sha256:<hex>" (§6.4)
  requestId?, attempt?,// the identity the handler submits under (§10.4)
  state,               // "pending" | "settled"
  status?,             // "ok" | "failed" | "cancelled"
  result?,             // status ok: the recorded value
  error?,              // status failed: { code, kind, message, detail? }
  external?,           // what the handler bound (recovery)
  cancel?,             // a scope: { losers: [branch keys], issued }
  branchDigest?,       // a race: the digest over the losers' bodies (§10.6)
  branches?,           // a scope that failed: its branch keys
  closed?,             // a conclave: whether membership was released
  startedAt, endedAt?  // host clock at begin and settle; a scope entry's endedAt is the
                       //   joined branch clock at settle (§8.1)
}
```

An entry is written **twice**: once `pending`, before the effect is dispatched, and once `settled`,
after; a reader folds by key and the last write wins. `result` and `error` are exclusive. `branches`
is present only on a failed scope, because a successful one carries them inside `result`. Unknown
fields MUST be ignored.

### 10.2 Keys

A step is keyed by **where** it is, never by when: `(scope path, kind, name, occurrence)`, with the
input hash compared **after** lookup so a changed input is a diagnosable divergence rather than a
silent miss. The key's string form, used in the journal, the trace and every error, is:

```text
scope frame  := "/" kind [":" name] "#" occurrence "/b:" branchKey
scope path   := scope frame*                       // "" at the root
step key     := scope path "/" kind [":" name] "#" occurrence
```

Examples: `/turn:build#0`, `/race:first-answer#0/b:reply/wait#0`,
`/parallel:checks#1/b:tests/turn:tests#0`. Nothing is escaped, which is why `/`, `#` and `:` are
refused in names and branch keys (§6.2). Occurrences are counted per `(kind, name)` within one
namespace, and every branch of a scope is its own namespace, so two branches calling the same named
effect never race for a counter. Both counters are allocated synchronously at the call, before any
await, which is the whole determinism argument: the allocating code is either sequential or already
inside a deterministic namespace.

### 10.3 The digest

`digest(value)` is `"sha256:" + hex(SHA-256(canonical(value)))` where `canonical` is RFC 8785. The
program hash is `digest({ source })`; an input hash is `digest(projection)` (§6.4).

### 10.4 The request id

The identity a handler submits under is written on the pending entry **before** the handler runs:
`base64url(SHA-256(canonical([runId, stepKeyString, inputHash, attempt])))`, 43 characters in the id
token alphabet. `attempt` is 0 except for the second mint of an escalated checkpoint (§6.5), which
is re-issued on the same entry as attempt 1 before it is dispatched. A resumed run that finds a
pending entry re-submits under the **recorded** id and attempt, never a re-derived one, so the far
side recognises the work rather than receiving a second request.

### 10.5 Two phases, two failure domains

An implementation MUST await the durable append of the pending entry before dispatching, MUST
settle the entry from the handler's outcome, and MUST keep the settling append outside the handler's
failure domain: a handler that completed and a store that refused to record the completion is a
**durability failure** (L5010), never a recorded `failed` step. A journal belongs to one run; an
entry from another run is refused (L5011).

### 10.6 Scope entries

A scope writes one entry of its own kind, keyed in the namespace that opened it, beside the effects
of that namespace; its branches live under it. On success `result` is `{ branches: [keys], value }`
where `value` is the scope's result (`{ index, value }` for a `race`); on failure `branches` is
carried as a fact. A cancelling scope records `cancel: { losers, issued }`: the intent travels with
the outcome, and `issued` flips only once the driver has established the losers are quiescent,
because a journal write cancels nothing by itself. A `race` whose branches are an object literal
records `branchDigest`: `digest` over `[[loserKey, body] ...]` sorted by key, where `body` is the
loser's function node with `start`, `end`, `loc` and `range` removed (or `null` for a key with no
literal body), so a reformat is silent and an edit is not. A `conclave` records `closed`.

### 10.7 Lookup

At each effect the interpreter looks its key up and acts on one of six verdicts: **miss** (perform
it live), **replay** (return the recorded result, advance the clock, perform nothing),
**replay-failed** (throw the recorded error), **replay-cancelled** (raise cancellation in this
branch), **pending** (re-bind to `external` under the recorded request id and await its terminal),
**diverged** (the recorded `inputHash` differs: stop, mutate nothing, name the step; L5001).

A settled **scope** is delivered from its own entry without entering a branch: the subtree is
accounted for (a loser still `pending` is settled `cancelled`), then the cancellation intent is the
driver's to discharge, and only then is the outcome delivered. On a migration walk (§11.2) the
recorded **winning** branches are entered instead so that removed steps inside them surface.

## 11. Resume, migrate, fork

### 11.1 Resume

Resume is not a cursor: it is **re-running the program from the top** under the recorded pins,
with journalled effects returning recorded results by key. Out-of-order concurrency replays
correctly because keys are structural, and no continuation or interpreter state is ever serialized.
A resume MUST refuse a journal that belongs to another run (L5011), a pin that differs (L5009), a
language version that differs (L5008), and history without pins (L5021); it MUST stop on the first
divergence (L5001). Where a build dispatches to more than one engine, a record whose version no
engine of that build serves is refused before any of this, with L5023 (§8.4), and the run MUST be
left untouched: nothing activated, nothing appended. (A recorded branch missing from the source is L5022 only on a migration or fork
walk entering a SETTLED scope, §11.2; a `pending` scope records no arm names to check and is
re-entered by a resume.) A resume performs live every
effect the journal has not settled, so a run that stops before its next effect (L5012, the host's
release, asked before every unrecorded effect and never inside one) is exactly where its journal
says it is.

### 11.2 Migrate

A **migration** moves a run onto edited source. It is decided by a **dry walk** of the new program
over the recorded journal with a read-only journal, and the walk answers two questions: whether each
recorded step is still valid (the hash comparison, on the raw fact) and which recorded steps the new
program still reaches (through the program's own view, checkpoint policy applied). Steps the walk
never looks up are **orphans**, and what happens to each depends on what it did:

| Orphaned kind | Verdict |
| --- | --- |
| `sleep`, `wait`, `monitor`, `ask` | ignored: nothing outlives it |
| `turn` | kept: the agent already spoke; the record stays and the migration says the source no longer accounts for it |
| `notify` | ignored if its notice was carried by the addressee's next turn; else **rejected** (L5013) |
| `conclave` | ignored if `closed`; else **rejected** (L5014) |
| `spawn` | **rejected** (L5003) unless the agent is adopted or released by an explicit override |
| `checkpoint` | ignored if never resolved; a resolved one is **rejected** (L5004) unless discarded by an explicit override, recorded with the actor |
| `parallel`, `race`, `fanOut` | ignored: a scope outlives nothing of its own |
| any other kind | **rejected** (L5015): a kind with no policy is not waved through |

A divergence inside a reached step is a rejection naming the step (L5001); an edit inside a losing
arm of a recorded `race` diverges through the branch digest (§10.6). The decision is filed as a
`migration` record (SPEC.md §14) whose id is a digest of the report itself, so a walk re-run after
a crash lands on the same record.

### 11.3 Fork

A **fork** starts a **new run** whose journal is a copy of a parent's prefix up to, and excluding,
a named step key (never an ordinal), under the parent's pins **unchanged, seed included**: a
reseeded prefix would re-decide every pure draw inside history it is supposed to copy, and no entry
records a draw. The cut is found by a dry walk in migration mode (§11.2), so a cut inside a settled
scope is found rather than swept past. The cut step MUST exist in the parent's journal (L5017), MUST
be reached by the parent program's own path (L5018), and MUST NOT lie inside a scope whose outcome
was already decided (L5020, a race loser's step); a fork that asks to pin a new program hash is
refused (L5002) until the run record carries one. Agents the prefix spawned are respawned at the
frontier by default and adopted only where the spawn said `onFork: "adopt"`, and a host that cannot
honour that refuses (L5019). The child is a new run under a new id; this revision records no
lineage on it (SPEC.md §14.3), so the parent and the cut are known to the caller that forked, and
the parent is untouched.

## 12. Limits

An implementation MUST enforce the run's `stepBudget` per walk (L4013) and `effectCeiling` per run
(L4009), and MUST yield to its host at least every `yieldEvery` dispatches so a pure loop cannot
starve the host's timers. The step and the dispatch are the engine's own unit (§8.4); an effect is
not, and `effectCeiling` counts the same thing under either version. The journal store's payload bound is the store's own: an entry it will not
take is a refused append (L5010, §10.5). L5006 is reserved for a result-size check ahead of the
append and is not raised by this revision.

## Appendix A. The error catalog

Codes are stable. L1xxx grammar, L2xxx names and static rules, L3xxx effect call shape, L4xxx run
time, L5xxx durability, L6xxx simulation.

| Code | Title |
| --- | --- |
| L1001 | Forbidden syntax: `class` |
| L1002 | Forbidden syntax: `this` |
| L1003 | Forbidden syntax: `var` |
| L1004 | Forbidden syntax: `for...in` |
| L1005 | Forbidden syntax: generator |
| L1006 | Forbidden syntax: `eval` or `Function` |
| L1007 | Forbidden syntax: regular expression literal |
| L1008 | Newline hazard |
| L1009 | Unbraced branch |
| L1010 | `switch` case does not terminate |
| L1011 | Computed property name |
| L1012 | Array elision |
| L1013 | Forbidden syntax: `with` |
| L1014 | Forbidden syntax: symbol |
| L1015 | Forbidden syntax: accessor |
| L1016 | Forbidden syntax: `instanceof` |
| L1017 | Forbidden syntax: label |
| L1018 | Forbidden syntax: tagged template literal |
| L1019 | Forbidden syntax: `new` |
| L1020 | Forbidden syntax: `import` or `export` |
| L1021 | Forbidden syntax: `delete` |
| L1022 | Forbidden syntax: `do...while` |
| L1023 | Forbidden syntax: `await` outside an async function |
| L1024 | `return` outside a function |
| L1025 | Forbidden syntax: loose equality |
| L1026 | Forbidden syntax: comma operator |
| L1027 | Forbidden syntax: `void` |
| L1028 | Forbidden property name |
| L1029 | Syntax outside the language |
| L1030 | Forbidden literal: bigint |
| L2001 | Unknown identifier |
| L2002 | Shadows a builtin or a primitive |
| L2003 | Assignment to a `const` binding |
| L2004 | Use before declaration |
| L2011 | The Promise API is not available |
| L2012 | Host global is not available |
| L2013 | An async call is not awaited |
| L2031 | Mutation of a frozen value |
| L2032 | Write from a concurrent branch to something declared outside it |
| L3011 | Unknown option key |
| L3012 | Missing required step name |
| L3013 | Step name is not a literal |
| L3014 | Malformed step name |
| L3021 | `fanOut` has no stable key |
| L3022 | Two agents share a worktree concurrently |
| L3023 | Array-form `parallel` holds named effects |
| L3024 | `fanOut` branch keys are not unique |
| L3025 | Branch key contains a reserved step-key character |
| L3041 | Value cannot cross an effect boundary |
| L3042 | Function passed as effect data |
| L3043 | `notify` fact is not a bounded decision record |
| L3044 | `to` without `onExpiry: "escalate"` |
| L4001 | Permit exhausted |
| L4002 | Agent down |
| L4003 | Turn deadline elapsed |
| L4004 | Handoff across worktrees |
| L4005 | Handoff to an agent outside the run |
| L4006 | `ask` never produced a conforming record |
| L4007 | Checkpoint expired |
| L4008 | Concurrent worktree write |
| L4009 | Run effect ceiling reached |
| L4010 | Field access on `null` or `undefined` |
| L4011 | Call of a value that is not a function |
| L4012 | Assertion failed |
| L4013 | Step budget exhausted |
| L4014 | Unknown member |
| L4015 | Not iterable |
| L4016 | Builtin failed |
| L4017 | Invalid array length |
| L4018 | No implicit conversion |
| L4019 | Array write past the end |
| L4020 | A method is not a value |
| L4021 | A callable `then` is not a record member |
| L5001 | Run divergence |
| L5002 | Program hash not available |
| L5003 | Orphaned `spawn` on migrate |
| L5004 | Orphaned resolved checkpoint on migrate |
| L5005 | A pending effect cannot be recovered |
| L5006 | Effect result too large |
| L5007 | Lease lost |
| L5008 | Resume under a different language version |
| L5009 | Resume pin mismatch |
| L5010 | Journal append rejected |
| L5011 | Journal belongs to a different run |
| L5012 | Run released before the next effect |
| L5013 | Orphaned undelivered `notice` on migrate |
| L5014 | Orphaned open `conclave` on migrate |
| L5015 | No orphan policy for this entry kind on migrate |
| L5016 | Effect not durable on this host |
| L5017 | Fork cut step is not in the journal |
| L5018 | Fork cut was never reached |
| L5019 | Fork cannot honour `onFork` on this host |
| L5020 | A fork cut lies inside a scope whose outcome was already decided |
| L5021 | Resume over a journal without the run's pins |
| L5022 | A recorded branch is not in the migrated source |
| L5023 | No engine in this build serves this record's language version |
| L6001 | Unscripted effect in simulation |
| L6002 | Simulation script entry unused |

`L4000` is not a catalog code: it is the generic code an unclassified failure carries (`kind`
`handler-fault`, `scope-fault`, or `host`), and it is what a program sees for a failure the catalog
does not name. L3022, L4001 to L4006 and L4008 are the effect handler's failure vocabulary: a host
reports them, the interpreter journals and delivers them, and none is raised by the language itself.
L1006, L1014, L5005, L5006, L5007 and L6002 are reserved: no path in this revision raises them.
L6001 and L6002 belong to the reference implementation's simulator (`SimHandler`, `dryRun`), which
runs a program against a script of scripted answers and refuses an effect the script does not
answer; simulation is a tool, not part of this language, and this document does not define it.

## Appendix B. Change log

| Date | Revision |
| --- | --- |
| 2026-08-18 | First normative reference, language version `1`, alongside SPEC.md v0.5 §14. |
| 2026-08-18 | Review folds, same revision: the PRNG separator is U+0000 (§8.2, the earlier text said a space and was wrong; the code never changed); `any`/`all` are no longer reserved (§3); `xs.length = n` truncates only, L4017 (§4.3); the L2013 rule states where the validator can see (§2.3); `fanOut` fails like `parallel` (§7.4); L5022 is a walk refusal, not a resume stop (§11.1); no lineage on a fork's child (§11.3); `schema` is opaque and concurrent turns on one handle are the handler's (§6.5); the checkpoint entry's `attempts` chain (§6.5). |
| 2026-08-18 | Language-lane folds, same revision: operators, computed member keys and the library's primitive parameters coerce primitives only, an array, record or function operand is refused (L4018, §4.5, §5.4); the dead zone is refused statically where visible and at run time otherwise (L2004, §2.3, §3); bigint literals are refused (L1030, §2.2); array index writes are contiguous and an at-length write appends (L4019, §4.3); a method is not a value (L4020, §4.2, §5.2); holes, cycles and an own `__proto__` field cannot cross, stringify or parse in (§4.4, §5.1); `sort`'s total order is defined over kinds with `NaN` placed (§5.3); the string `replace`/`replaceAll` replacement is an ECMAScript substitution string (§5.2); crossing values are frozen in both directions, replayed results included (§4.3); a scope entry's `endedAt` is the joined branch clock (§8.1, §10.1); a race re-decides a cut when an in-flight effect lands (§7.3); cancellation holds across the boundary's own begin gap (§7.6); an uncatchable fault skips `finally` (§9.2), and `finally` otherwise carries ECMAScript's completion semantics (§9.1). |
| 2026-08-19 | A record may not carry a callable `then`, on a literal, a spread, a rest pattern or a member write alike, literal key or computed (L4021, §4.3): an object with a callable `then` is a thenable, the host's promise machinery adopts it in place of the value the program built, and its failure escaped the run as an unowned rejection that killed the host. |
| 2026-08-19 | Language version `2`, the compiled engine, alongside version `1`, the tree-walker (§8.4): a step is the engine's own unit and budgets are not comparable across versions (§8.3, §12); `log` is data under version 2 and refuses code (L4016); an engine stamps and compares its own version, so a record binds only under the engine that wrote it (L5008); and a build that dispatches to engines refuses a version none of its engines serves, naming what it does serve, leaving the run untouched (L5023, §11.1). |
