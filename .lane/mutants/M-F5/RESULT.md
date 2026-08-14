# M-F5 — MEASURED. Answers review's finding 1 (vacuous hermeticity cells) with two mutants.

The finding: *"The suite creates `PROJ/.cotal` and `HOME_D` before any CLI run, then 'proves'
hermeticity only by checking those same pre-created paths exist. Directory existence established
before the run proves neither."* Review demonstrated it — child `HOME` redirected to an external
decoy, setup wrote `.agents` there, suite stayed **20/0**, `mutation-proof` **SURVIVED**.

The replacement is not a stronger assertion over the same evidence; it is different evidence. A
before/after fingerprint (presence AND mtime) over the marker paths a `setup` run creates, with the
`HOME` and `COTAL_HOME` redirections witnessed **separately** because they are separate mechanisms.

## Predicted first, at `62b18604`, before either mutant existed

`prediction.txt` was committed before the file was touched, naming the cells rather than a count,
and registering non-equivalence in advance for each mutant.

| mutant | what it changes | predicted RED (by name) | measured |
| --- | --- | --- | --- |
| **A — the decoy** | child `HOME` → an external dir; `COTAL_HOME`/`XDG_CONFIG_HOME` untouched | `HERMETIC: the run's HOME-rooted state landed in the SCRATCH home` | **KILLED — 25 passed, 1 failed, exactly that cell**, rc `1` |
| **B — the protected path** | the watched path becomes `HOME_D` (which provably changes); `HOME` stays correctly redirected | `HERMETIC: the OPERATOR's real home is byte-for-byte unchanged` | **KILLED — 25 passed, 1 failed, exactly that cell**, rc `1` |

**Every predicted-green cell stayed green in both runs**, including the ones predicted green for a
stated reason: mutant A left the `COTAL_HOME` witness green because `COTAL_HOME` is not what it
moves, and left the inverse control green because writes still reach `HOME_D` through it.

Baseline at `e3d6506b`: **26 passed, 0 failed**, rc `0`. Restores verified by
`git diff --quiet` scoped to the mutated file: `0` both times.

## Non-equivalence, measured rather than argued

`decoy-witness.txt` is a listing of the decoy directory taken while mutant A's effect was still on
disk: `.agents`, `.claude`, `.claude.json`, `.npm`. The mutated program wrote HOME-rooted state into
an operator-visible directory that the unmutated program never touches. The two differ in a
filesystem effect, not only in a test's opinion — which is the whole of what makes the killed cell
mean something.

## ⚠️ What mutant B deliberately does NOT do

It does not point `HOME` at the operator's real home to prove the invariance cell fires. That would
verify the guard by committing the offence. It moves the **watched path** instead, onto a directory
the suite already proves changes, so the comparator is exercised in the failing direction while
nothing is written outside the scratch.

## What neither mutant proves

- That the real `~` is protected when the suite runs with `HOME` unset or aliased to the scratch.
  Both are **refusals** in the source (`throw`, not a pass) and neither refusal is exercised here.
- That `mutation-proof` reports these. The mutants are on a suite's own environment table, applied
  and restored by `run.sh` with the diff, the outputs, and the exit codes recorded per arm.
- Anything about scope 2's live behaviour. No broker was started.

## Evidence — contents, not just tracking

`git ls-files` answers *is this tracked*, not *does it contain what this table says* — the lesson
M-R5 had to be taught twice. Read the sizes back:

    git ls-files .lane/mutants/M-F5/ | while read -r f; do printf '%8s  %s\n' "$(wc -c < "$f")" "$f"; done

| file | what it is |
| --- | --- |
| `prediction.txt` | committed at `62b18604`, BEFORE either mutant was applied |
| `base-sha.txt` | the base recorded by the run itself |
| `mutantA.diff` / `mutantB.diff` | the exact diffs, non-empty (an empty diff **refuses at 95**) |
| `mutantA.out` / `.rc` | 25 passed, 1 failed / rc `1`, with the command line as its first line |
| `mutantB.out` / `.rc` | 25 passed, 1 failed / rc `1`, likewise |
| `restoreA.rc` / `restoreB.rc` | `restore-clean.rc=0` — scoped to the mutated file |
| `decoy-witness.txt` | the decoy's contents under mutant A: the observable effect |
| `decoy-path.txt` | the decoy path (removed after the witness was taken) |
