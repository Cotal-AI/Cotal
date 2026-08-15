# Is the mutation harness's restore signal-safe? Driven, not reasoned.

**Stamped `2026-08-15T06:56:09Z` (`date -u` at writing), lane tip `63ddca6e` + the uncommitted
patch this file documents.** Condition 4 of fm-orchestrator's ruling, answered before the MX14
window opens.

## The answer is worse than the question assumed

The question was "if a `SIGKILL` can strand it, say so". Measured:

```
grep -c "process.on(" scripts/mutation-proof.mjs   →   0     (at HEAD 63ddca6e)
```

**There were no signal handlers at all.** The restore lived in a `try/finally` only, so a plain
Ctrl-C — not merely `SIGKILL` — left the mutant in the shared tree. That is the common case, not
the exotic one.

## The control, and what would have refuted it

Two arms, identical fixture, identical interrupt: `kill -INT -<pgid>` to the whole process group,
which is what Ctrl-C in a terminal actually sends. Fixture is a throwaway git repo in `/tmp`; no
core, no broker, nothing of this repo's touched.

The probe's runtime **depends on the file's content**, so the arms *can* differ:

```js
if (!readFileSync("victim.ts","utf8").includes("MUTANT")) process.exit(0);  // baseline: fast, green
setTimeout(() => process.exit(1), 120000);                                   // mutant: hangs, signalable
```

**Refutation stated before the run: if BOTH arms restore, the handler changes nothing observable
and I say so.** It did not happen.

| arm | harness | mutant in tree at T+6s | after group SIGINT |
| --- | --- | --- | --- |
| 1 | `git show HEAD:scripts/mutation-proof.mjs` (0 handlers) | yes | **❌ `GUARD = "MUTANT"` — STRANDED** |
| 2 | patched (1 handler, 3 signals) | yes | **✅ `GUARD = "ORIGINAL"` — restored** |

Two earlier attempts were **invalid controls and are recorded as such**: the first tripped the
harness's dirty-tree refusal (an `out.log` I had written inside the repo), the second signalled at
T+8s while the run was still in a 60s baseline, so no mutation had been applied and both arms were
silent for the wrong reason.

## The mechanism is NOT the one I assumed, and this matters

My first reading of arm 2 was "the handler restored it". **That was wrong, and the log refutes it:**
arm 2 printed `KILLED … All 1 mutation(s) killed` — the harness *completed normally*. The handler
body never ran.

The reason is line 90:

```js
const r = spawnSync(command, { cwd, shell: true, … });
```

**`spawnSync` blocks the event loop for the entire mutant window.** Node cannot dispatch a JS
signal handler while it is blocked, so a handler body is unreachable during precisely the span it
was written to protect.

What actually saves the tree is subtler: **registering a listener replaces the signal's default
disposition.** With no listener, `SIGINT` is `SIG_DFL` and the kernel terminates node mid-`spawnSync`
— mutant stranded (arm 1). With a listener, the process is not killed; `spawnSync` returns, and the
ordinary `finally` restores (arm 2).

**So the protection comes from the listener's EXISTENCE, not its body.** The body is defensive cover
for a signal arriving in the narrow gaps when the loop is free. I am not claiming it is exercised —
it is not, in either arm measured.

An earlier single-arm run at T+8s that I read as a pass was also this: elapsed **121s** for a 120s
hang, `grep -c SIGINT` on the output **0**. The run completed; nothing was interrupted.

## The residual, named for fm-orchestrator's decision

**`SIGKILL` strands the mutant, and cannot be made not to.** Driven, same fixture, patched harness:

```
kill -KILL -<pgid>  →  ❌ STRANDED — export const GUARD = "MUTANT";
```

`SIGKILL` is uncatchable by definition; no handler closes this. **Recovery is git, and it works:**
`git checkout -- <file>` restored the fixture cleanly. That is the same recovery
`mutation-proof`'s own docblock names — it refuses a dirty tree specifically so git remains the
recovery path.

**For MX14 this residual means: if the harness is `SIGKILL`ed inside the window, `packages/core/src/endpoint.ts`
holds the mutant until someone runs `git checkout`.** The mutant is source, not build — nothing
executes it until a `tsc` runs, which is what the freeze exists to prevent. It is a real residual
and it is fm-orchestrator's to accept, not mine.

## What changed in `scripts/mutation-proof.mjs`

Handlers for `SIGINT`/`SIGTERM`/`SIGHUP` that restore, clean up any private build, remove
themselves and re-raise so the exit status stays truthful; `clearSignals()` at all three normal
exit paths so the harness cannot hang on its own listeners.
