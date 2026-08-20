# @cotal-ai/lang

## 0.25.0

### Minor Changes

- 0471af2: The driver hosts the version-2 compiled engine: a fresh run is stamped language version 2 and executes on the engine in its own locked-down worker thread, while every version-1 record keeps replaying on the tree-walker and a record whose version the build does not serve keeps refusing by name (L5023). The engine gains a bridged handler route for hosts whose effect handler is a live object: the handler and the durable journal store stay in the host process, and the worker forwards the effect seam over a message port, so effects stay durable pending-before-effect and no socket or credential enters the isolate holding the program. Failures cross the thread boundary whole: an EffectError keeps its code, kind and detail, a release keeps its reason, and a lost journal is regraded as the class the driver's outcome contract names. A race loser's cancellation crosses the bridge and fires the host handler's signal while the effect is still in flight (a cancel aimed at an effect that already answered does not cross, which is the only time a handler could not act on one anyway). The driver also refuses a malformed run record by its own name: a `languageVersion` that is not a string is released as malformed before the engine table is consulted, instead of being misread as an unserved version. A stop check that throws inside the host's poll is re-raised as the run's fault on the caller's stack rather than escaping as an uncaught exception.
- dbeec0f: The language version belongs to the engine that runs a program, and a build declares which engines it hosts.

  There are two engines and now two versions: the tree-walker is language version `1` and stays the
  replay engine for every run recorded under it, and the compiled engine is version `2`, a different
  language rather than a faster one, since `log` is data there and refuses code, and a step is a
  transformed-site hit rather than a walker dispatch. `resolvePins` and `bindPins` take the version as
  an argument, so each engine stamps its own and compares against its own; `WALKER_LANGUAGE_VERSION`
  and `ENGINE_LANGUAGE_VERSION` are exported beside `LANGUAGE_VERSION`, which is an alias for the
  current language, the engine's.

  Bumping one shared constant was measured and is not available: the walker would stamp 2 and compare
  1, and every walker fresh-run-then-resume round trip fails. Leaving it at 1 while the engine speaks
  2 fails the other way, on records already written. Each engine stamping and comparing its own breaks
  neither.

  The run driver now holds a table of the versions this build hosts, ordered by declared precedence
  rather than by a string sort. A fresh run is stamped with the version of the engine that will
  actually execute it, and a record whose version no engine here serves is released by name with the new **L5023**,
  naming both the version it met and the set this build serves, with the run left untouched: nothing
  activated and nothing appended. It is released rather than failed or thrown, because a build that
  cannot host a language has observed nothing about the program.

  Migration: `resolvePins(options, now)` and `bindPins(recorded, options)` now require a third
  argument, the calling engine's version. Callers inside this repo pass their own; an external caller
  passes `WALKER_LANGUAGE_VERSION` to keep today's behaviour. Records do not cross between versions in
  either direction, which was already true and is now enforced by the engine that meets them.

- d3553be: `SimScript.checkpoints` no longer accepts an `at`, because the simulator never honoured one.

  `SimHandler.checkpoint()` has two return paths and both stamp `at: this.virtualNow`, so a value
  written into a checkpoint script was required by the type and then discarded. The cost was not the
  wasted field, it was that every fixture carried a timestamp that meant nothing and read to the next
  author as though the simulator were using it.

  The scripted type is now `Omit<CheckpointResultValue, "at">`.

  Migration: a checkpoint script written as a fresh object literal in the call itself is now a type
  error if it passes `at`. Delete the field.

  Know the limit as a RULE rather than as a list of shapes. Three earlier versions of this note gave a
  list, of one shape, then two, then two escapes, and every one of them was short. The rule: the error
  fires exactly where `SimScript` is already the expected type of the literal you are writing, and
  nowhere else. Where it fires, the fix is deleting one field.

  Stated that way it reaches the shapes a list kept missing. Writing the literal at a call that takes a
  `SimScript`, under a `SimScript` annotation on a `const` or on a `let` you assign later, in a
  parameter declared `SimScript`, and under `satisfies SimScript` are all errors now. It also settles
  what escapes without a second list: anywhere the literal is typed before it meets this type, or is
  never measured against it at all. A value whose type is inferred and only then passed by name
  escapes, so does one put through an `as` cast, and so does one handed to a parameter declared
  `unknown`. That last one is how the three sites in the runtime consumer escape: their helper takes
  `script: unknown` and casts inside, so their literal is never checked against `SimScript` at all.
  All of those still compile with `at` present and still have it discarded, silently, exactly as
  before. Measured across the whole repository at this commit that is **seven pre-existing consumer
  fixtures**, and three of them are in the runtime consumer rather than in this package's own tests,
  so the discarded field is not confined to the package that defines the type. Two of the seven are
  worth naming, because a first count of this missed them and a second reader found them: the two
  scripts in `packages/lang/smoke/differential.smoke.ts` sit in a corpus whose tuple declares that
  slot as `object`, so they are never measured against `SimScript` at all. That is the third escape
  this paragraph lists, and it is the one a count reaches for last, because the other two at least
  name the type they slip past. An eighth literal with `at` exists at this commit and is deliberately
  not one of the seven: this change adds it, in
  `packages/lang/smoke/sim.smoke.ts`, as the cell that proves the implementation discards a scripted
  `at` on both return paths. It escapes the same way, through a parameter declared `unknown`, which
  is the point of it. The type closes the
  two idioms a new author reaches for first; it does not close the loophole.

  Nothing about the value the simulator produces changes, because it was always stamped from virtual
  time.

  One more shipped type, and it moves in the same direction: `EngineCtx.call` declared
  `args: unknown[] | (() => unknown[])` while the implementation writes
  `typeof args === "function" ? await args() : args`. An async thunk is accepted at runtime and the
  engine suite passes one deliberately, to prove the arguments arrive as a list rather than as a
  promise, so the declaration was the half that was wrong. It is now
  `unknown[] | (() => unknown[] | Promise<unknown[]>)`. Nothing about what the engine accepts changes;
  a caller that was already passing an async thunk stops needing a cast to say so.

  Those two are the whole of the shipped change. The rest of that work is test-tree only: the
  `packages/lang` smoke files now typecheck under a check-only project, which is a gate, not a
  behaviour.

### Patch Changes

- dc34423: `len` counts an array or a string and refuses every other kind in the language, so a function's host arity can no longer leak into a program value.

  The builtin read `.length` off whatever it was handed. For a function that is the host's `Function.length`, and inside the interpreter it is the arity of the implementation's own wrapper: measured live before the fix, `len` of a program function answered 2 whatever parameters it declared, `len` of a builtin answered 0, `len` of a record, a number or a boolean silently answered undefined, and `len(null)` surfaced the host's TypeError text. A host-object internal was crossing into program values, against the language's determinism invariant: there is no ambient host property a program should reach.

  `len` now accepts exactly the value kinds that have a length of their own, an array's elements and a string's units, and refuses every other kind with L4016 in the language, before the host is reached: no host property is read, no host error text appears, and the refusal is catchable. For a record's size, `len(keys(r))`. The spec's library-failure section and its change log carry the rule in the same change.

- 445e110: A record may not carry a callable `then`, and the run that tries to build one now refuses it with L4021 instead of dying.

  To the host's promise machinery any object with a callable `then` is a thenable, and resolving a promise with one calls the record's own `then` instead of delivering the value. Inside the interpreter every function is async, so a program-authored `then` that throws turned that throw into the rejection of a promise nobody owns: it escaped `run()` as an unhandled rejection and killed the host process, while the await that adopted the record never settled and the run hung behind it with its journal and its lease. Measured live before the fix: a program returning `{ then: () => { throw { code: "stray-then" } } }` from a function left the host dead with an unowned rejection and `run()` forever pending.

  The refusal is at the write, on every route that can put a member on a record: a literal key or a computed one, in an object literal, a spread, a rest pattern, or a member assignment. No thenable value ever exists for the machinery to adopt, on any path, the same way the language carries no sparse arrays and no `__proto__` fields. A `then` that is not callable is untouched data, and functions under any other member name are unaffected. The spec's record rules (§4.3), its error catalog, and its change log carry the rule in the same change.

## 0.24.0

### Minor Changes

- 9939dcc: The pure fragment of cotal-lang is JavaScript, and the run's outcomes are decided by recorded facts.

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

- b7cc4fa: Host a cotal-lang run on the mesh.

  `@cotal-ai/lang` gains the durability the language rested on but did not have: run pins with a
  run clock, scope journal entries that record a race's winner and its losers so a replay resolves
  the same arm, a refusal when a resume is handed a journal without the pins that decide it, and an
  effect ceiling read from the pins rather than a default.

  `@cotal-ai/core` gains the step journal's storage plane, the run record and its lease, the
  checkpoint answer record, and the notice and migration records.

  `@cotal-ai/runtime` is new: the mesh handler that performs a program's effects on the real planes
  (durable pauses on the checkpoint plane, event awaits over durable consumers, notices), the
  `RunDriver` the manager daemon hosts, journal-replay resume, migration onto edited source, and a
  fork that redoes work under a new run id. Effects that need durable actions refuse through one
  named seam rather than pretending to succeed.

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.0

### Patch Changes

- 758e1e3: Pin `json-canonicalize` exactly, so a published install cannot resolve a broken tarball.

  `json-canonicalize@2.0.1` was published without the `bundles/` directory its own `package.json`
  `main` points at. A `^2.0.0` range therefore resolves, on any fresh install, to a package that
  cannot be imported: `cotal --version` crashes with `ERR_MODULE_NOT_FOUND` before printing
  anything.

  The repo never saw it. A lockfile pins 2.0.0 and CI stayed green throughout; a published package
  carries no lockfile, so npm re-resolves every range at install time and users got a version CI had
  never exercised. That gap between what CI resolves and what an install resolves is the actual
  defect this fixes.

  Both ranges are now exact, and `smoke:dep-pins` keeps them that way: it fails if either floats
  back to a range, and fails if its quarantine list stops matching any declared dependency, so a
  list that has quietly stopped applying cannot read as a list that holds.

  Stated as a limit rather than left implied: the new cell proves the range is exact, not that the
  pinned version is installable. Only installing the packed tarball against the live registry proves
  that, which is `smoke:seed-tarball:live` - and that suite sits outside `smoke:ci`, so the
  instrument that would have caught this incident exists and does not run. Wiring it into the gate
  is a separate decision about live-network tests in CI, not something this change makes quietly.

## 0.18.0

### Minor Changes

- df4d37e: Version `@cotal-ai/lang` with the rest of the workspace. It is a public package (`packages/lang`, alongside `core` and `workspace`) but was missing from the `fixed` group, so Changesets never bumped it: it stayed pinned at 0.15.0 while every other package moved, and `pnpm publish -r` would have pushed a version permanently out of lockstep with the release it shipped in. Joining the group means it versions and publishes with everything else.
