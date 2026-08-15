# The suite files this lane's evidence rests on are never typechecked

Found `Sat Aug 15 12:39 AM UTC 2026` (`date -u`, read at the moment of writing) at tip `3a99c8c1`,
while looking for a **non-broker** way to confirm the tree after the history rewrite. Filed as its
own record because the gap is in the instrument, not in the thing measured.

## The gap

`pnpm typecheck` is green — **21 packages `Done`, rc=0**, `connector-core` among them, driven at
`3a99c8c1`. That green says **nothing about this lane's suite**:

    extensions/connector-core/tsconfig.json  ->  "include": ["src"]

`smoke/` is not in `src/`. Checked rather than assumed — the project's own file list does not
contain it:

    tsc -p tsconfig.json --listFiles --noEmit | grep -c 'smoke/connection-control.smoke.ts'
    0

**So `connection-control.smoke.ts` — the file every count in `RESULTS.md` comes from — has never
been typechecked by anything.** It is only ever *run*, by `tsx`, which strips types without
checking them. A test file that is never typechecked can hold a comparison that cannot be true, and
nothing in the repo would say so.

## What closing the gap actually found, and what it is NOT

Typechecking the file directly returns exactly one error:

    smoke/connection-control.smoke.ts(227,74): error TS2367:
      This comparison appears to be unintentional because the types 'true' and 'false' have no overlap.

Line 227 is `A3c`, which exists **because mutation testing killed the weaker form** — removing all
three self-disconnect guards left `A3`/`A3b` green, so `A3c` asserts the connection itself:

    check("A3c the connection is actually DOWN, not merely reported down", A.connected === false);

`'true' and 'false' have no overlap` reads as *a cell that can never pass*, which would make `A3c`
vacuous and would retract the mutation kill it was written to secure. **It is not that.** Driven
down rather than argued:

`A` is a real `MeshAgent` (`new MeshAgent(cfgA as any)`, line 136), and `MeshAgent.connected` is
`get connected(): boolean` (`src/agent.ts:236`) backed by `_connected`, which the endpoint's
`"connection"` event writes (`agent.ts:229`). At runtime the getter returns a real boolean and
`A3c` is a genuine assertion.

The literal `true` comes from **control-flow narrowing at the fixture guard on line 141**:

    if (!(A.connected && B.connected)) throw new Error("fixture failed: ...");

After that throw, TypeScript narrows the getter to `true` — and **does not widen it across
`await`**, though every `await` between line 141 and line 227 can change it.

### The mechanism, with a control that can differ

Two files identical but for the guard, through the same command shape and the same `tsc`
(`node_modules/.bin/tsc --noEmit --strict --target es2022`). **Stated before the result: if the
control had also reported TS2367, narrowing would be refuted and the cell would be in real
trouble.**

    // repro.ts — throw-guard, so `connected` narrows to `true`
    if (!A.connected) throw new Error("fixture failed");
    await sleep(10);
    if (A.connected === false) console.log("down");     // line 7

    // control.ts — same code, guard does NOT throw, so nothing narrows
    if (!A.connected) { console.log("not connected"); }
    await sleep(10);
    if (A.connected === false) console.log("down");     // line 7

| arm | result |
| --- | --- |
| repro (narrowing) | **`repro.ts(7,7): error TS2367`** — the predicted line |
| control (no narrowing) | **no TS2367** |

Both arms emit the same five unrelated `TS2792 undici-types` lines from `@types/node`, so the noise
is not what separates them. **The mechanism is confirmed: `A3c` is sound at runtime and the error
is a narrowing artifact.**

## What this changes

1. **`A3c` stands.** No count in `RESULTS.md` moves, and the mutation kill it secures is intact.
2. **The gap stands and is the real finding.** The suite files are outside every `tsconfig`, so a
   genuinely impossible assertion in any of them would ship green. This is the same shape as every
   other defect this lane has recorded: *a check that cannot fail, in the instrument rather than in
   the subject.*
3. **The fix is not simply adding `smoke/` to `include`** — that turns the tree red on a *correct*
   test, and a lane that discovers this at gate time will "fix" `A3c` by weakening it, undoing a
   mutation kill. Whatever lands has to keep the runtime assertion and satisfy the checker
   (re-reading the getter through a value the narrowing cannot follow is the small change), and it
   is a **fleet decision** about every package's `smoke/`, not this lane's call.

**Not fixed here, deliberately.** Reported to fm-orchestrator; a gap in a shared instrument is not
something one lane patches into its own head.

## Reproduction

    export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"    # Node 22 only
    cd extensions/connector-core
    npx tsc -p tsconfig.json --listFiles --noEmit | grep -c 'smoke/connection-control.smoke.ts'   # -> 0
    npx tsc --noEmit --module nodenext --moduleResolution nodenext \
            --target es2022 --strict --skipLibCheck smoke/connection-control.smoke.ts            # -> TS2367

No broker. No install. Read-only.
